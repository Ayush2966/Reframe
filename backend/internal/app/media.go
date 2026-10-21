package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"
)

// SourceInfo describes the uploaded video. Width and Height are the displayed
// size, i.e. after applying any rotation flag phones write into the file.
type SourceInfo struct {
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	Duration       float64 `json:"duration"`
	FPS            float64 `json:"fps"`
	FPSRational    string  `json:"fpsRational"`
	HasAudio       bool    `json:"hasAudio"`
	VideoCodec     string  `json:"videoCodec"`
	PixFmt         string  `json:"pixFmt"`
	BitDepth       int     `json:"bitDepth"`
	ColorSpace     string  `json:"colorSpace,omitempty"`
	ColorTransfer  string  `json:"colorTransfer,omitempty"`
	ColorPrimaries string  `json:"colorPrimaries,omitempty"`
	ColorRange     string  `json:"colorRange,omitempty"`
	Rotation       int     `json:"rotation"`
	SizeBytes      int64   `json:"sizeBytes"`
	HDR            bool    `json:"hdr"`
}

type probeOutput struct {
	Streams []struct {
		CodecType      string            `json:"codec_type"`
		CodecName      string            `json:"codec_name"`
		Width          int               `json:"width"`
		Height         int               `json:"height"`
		PixFmt         string            `json:"pix_fmt"`
		RFrameRate     string            `json:"r_frame_rate"`
		AvgFrameRate   string            `json:"avg_frame_rate"`
		ColorSpace     string            `json:"color_space"`
		ColorTransfer  string            `json:"color_transfer"`
		ColorPrimaries string            `json:"color_primaries"`
		ColorRange     string            `json:"color_range"`
		Duration       string            `json:"duration"`
		Tags           map[string]string `json:"tags"`
		SideDataList   []struct {
			SideDataType string  `json:"side_data_type"`
			Rotation     float64 `json:"rotation"`
		} `json:"side_data_list"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
		Size     string `json:"size"`
	} `json:"format"`
}

// Videos come from uploads and links, so ffmpeg must only treat them as plain
// media files. Without these limits a "video" that is really an HLS playlist
// or an ffconcat script makes ffmpeg open other files on this Mac.
const safeDemuxers = "mov,matroska,webm,avi,mpegts,mxf,flv,mpeg,asf,ogg,dv"

var inputGuards = []string{"-protocol_whitelist", "file", "-format_whitelist", safeDemuxers}

// safeInput is "-i path" for a file that came from outside.
func safeInput(path string) []string {
	return append(append([]string{}, inputGuards...), "-i", path)
}

func probe(ctx context.Context, ffprobe, path string) (*SourceInfo, error) {
	args := append(append([]string{"-v", "error"}, inputGuards...), "-print_format", "json", "-show_streams", "-show_format", path)
	out, err := exec.CommandContext(ctx, ffprobe, args...).Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return nil, fmt.Errorf("this file isn't a video ffmpeg can read: %s", firstLine(string(ee.Stderr)))
		}
		return nil, err
	}
	var p probeOutput
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, fmt.Errorf("reading video details: %w", err)
	}

	info := &SourceInfo{}
	foundVideo := false
	for _, s := range p.Streams {
		switch {
		case s.CodecType == "video" && s.Disposition.AttachedPic == 0 && !foundVideo:
			foundVideo = true
			info.Width, info.Height = s.Width, s.Height
			info.VideoCodec = s.CodecName
			info.PixFmt = s.PixFmt
			info.BitDepth = bitDepth(s.PixFmt)
			info.ColorSpace = s.ColorSpace
			info.ColorTransfer = s.ColorTransfer
			info.ColorPrimaries = s.ColorPrimaries
			info.ColorRange = s.ColorRange
			info.HDR = s.ColorTransfer == "smpte2084" || s.ColorTransfer == "arib-std-b67"

			rate := s.AvgFrameRate
			if parseRational(rate) <= 0 || parseRational(rate) > 240 {
				rate = s.RFrameRate
			}
			info.FPS = parseRational(rate)
			info.FPSRational = rate

			rot := 0.0
			for _, sd := range s.SideDataList {
				if sd.SideDataType == "Display Matrix" {
					rot = sd.Rotation
				}
			}
			if r, ok := s.Tags["rotate"]; ok && rot == 0 {
				rot, _ = strconv.ParseFloat(r, 64)
			}
			info.Rotation = int(math.Round(rot))
			if abs(info.Rotation)%180 == 90 {
				info.Width, info.Height = info.Height, info.Width
			}
			if d, err := strconv.ParseFloat(s.Duration, 64); err == nil {
				info.Duration = d
			}
		case s.CodecType == "audio":
			info.HasAudio = true
		}
	}
	if !foundVideo {
		return nil, errors.New("this file has no video track")
	}
	if d, err := strconv.ParseFloat(p.Format.Duration, 64); err == nil && d > 0 {
		info.Duration = d
	}
	info.SizeBytes, _ = strconv.ParseInt(p.Format.Size, 10, 64)
	if info.FPS <= 0 {
		info.FPS, info.FPSRational = 30, "30/1"
	}
	if info.Width < 16 || info.Height < 16 || info.Duration <= 0 {
		return nil, errors.New("couldn't read the video's size or length")
	}
	return info, nil
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func parseRational(s string) float64 {
	n, d, ok := strings.Cut(s, "/")
	if !ok {
		v, _ := strconv.ParseFloat(s, 64)
		return v
	}
	num, err1 := strconv.ParseFloat(n, 64)
	den, err2 := strconv.ParseFloat(d, 64)
	if err1 != nil || err2 != nil || den == 0 {
		return 0
	}
	return num / den
}

func bitDepth(pixFmt string) int {
	switch {
	case strings.Contains(pixFmt, "16"):
		return 16
	case strings.Contains(pixFmt, "12"):
		return 12
	case strings.Contains(pixFmt, "10"):
		return 10
	}
	return 8
}

// colorMatrix maps ffprobe's color_space to the names swscale accepts.
func (s *SourceInfo) colorMatrix() string {
	switch s.ColorSpace {
	case "bt709":
		return "bt709"
	case "smpte170m", "bt470bg":
		return "bt601"
	case "bt2020nc", "bt2020c":
		return "bt2020"
	}
	if s.Height >= 720 || s.Width >= 1280 {
		return "bt709"
	}
	return "bt601"
}

func (s *SourceInfo) colorRange() string {
	if s.ColorRange == "pc" {
		return "pc"
	}
	return "tv"
}

// colorParams is the colour description written on the output so players
// don't guess (and shift the colours). HDR transfer curves pass through.
func (s *SourceInfo) colorParams() (space, prim, trc, rng string) {
	m := s.colorMatrix()
	space = map[string]string{"bt709": "bt709", "bt601": "smpte170m", "bt2020": "bt2020nc"}[m]
	prim = s.ColorPrimaries
	if !knownPrimaries[prim] {
		prim = map[string]string{"bt709": "bt709", "bt601": "smpte170m", "bt2020": "bt2020"}[m]
	}
	trc = s.ColorTransfer
	if !knownTransfers[trc] {
		trc = map[string]string{"bt709": "bt709", "bt601": "smpte170m", "bt2020": "bt709"}[m]
	}
	return space, prim, trc, s.colorRange()
}

var knownPrimaries = map[string]bool{"bt709": true, "bt470m": true, "bt470bg": true, "smpte170m": true, "smpte240m": true, "bt2020": true, "smpte431": true, "smpte432": true}
var knownTransfers = map[string]bool{"bt709": true, "smpte170m": true, "bt470bg": true, "iec61966-2-1": true, "bt2020-10": true, "bt2020-12": true, "smpte2084": true, "arib-std-b67": true}

// colorTagFilter tags frames at the end of the graph. ffmpeg takes the
// output's colour tags from the frames, so encoder flags alone get dropped.
func (s *SourceInfo) colorTagFilter() string {
	space, prim, trc, rng := s.colorParams()
	return fmt.Sprintf("setparams=colorspace=%s:color_primaries=%s:color_trc=%s:range=%s", space, prim, trc, rng)
}

func (s *SourceInfo) colorTags() []string {
	space, prim, trc, rng := s.colorParams()
	return []string{"-colorspace", space, "-color_primaries", prim, "-color_trc", trc, "-color_range", rng}
}

// ffmpegRun runs ffmpeg with machine-readable progress on stdout and reports
// the fraction done (0..1) based on the expected output duration.
type ffmpegRun struct {
	Bin        string
	Args       []string
	Dir        string
	Duration   float64 // seconds of output expected, for progress
	OnProgress func(float64)
	Stdin      io.Reader
}

func (r ffmpegRun) Run(ctx context.Context) error {
	args := append([]string{"-hide_banner", "-nostats", "-loglevel", "error", "-y", "-progress", "pipe:1"}, r.Args...)
	cmd := exec.CommandContext(ctx, r.Bin, args...)
	cmd.Dir = r.Dir
	cmd.Stdin = r.Stdin
	var stderr tailBuffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		k, v, _ := strings.Cut(sc.Text(), "=")
		if k == "out_time_us" && r.OnProgress != nil && r.Duration > 0 {
			if us, err := strconv.ParseFloat(v, 64); err == nil && us >= 0 {
				r.OnProgress(clamp(us/1e6/r.Duration, 0, 1))
			}
		}
	}
	if err := cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("ffmpeg failed: %s", stderr.String())
	}
	return nil
}

// tailBuffer keeps only the end of a long stderr stream.
type tailBuffer struct{ b bytes.Buffer }

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.b.Write(p)
	if t.b.Len() > 8192 {
		rest := t.b.Bytes()[t.b.Len()-4096:]
		t.b.Reset()
		t.b.Write(rest)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	s := strings.TrimSpace(t.b.String())
	if s == "" {
		return "no error output"
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 4 {
		lines = lines[len(lines)-4:]
	}
	return strings.Join(lines, " / ")
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
