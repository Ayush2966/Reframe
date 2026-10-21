package app

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

// RenderSpec is what the editor sends to export (or preview) a video. The
// camera path is precomputed in the browser so the preview and the render
// can't disagree about where the frame is.
type RenderSpec struct {
	ProjectID string       `json:"projectId"`
	Path      PathData     `json:"path"`
	Outputs   []OutputSpec `json:"outputs"`
	Look      Look         `json:"look"`
	Size      string       `json:"size"`    // native | 1080 | 1440 | 2160
	Enhance   string       `json:"enhance"` // off | fast | ai | cloud
	Quality   string       `json:"quality"` // high | prores | lossless
	Trim      *Trim        `json:"trim,omitempty"`
}

// PathData is where the frame should be centred, sampled Rate times a second
// from the start of the source, in 0..1 coordinates of the displayed frame.
type PathData struct {
	Rate float64   `json:"rate"`
	X    []float64 `json:"x"`
	Y    []float64 `json:"y"`
}

type OutputSpec struct {
	ID   string `json:"id"`
	RW   int    `json:"rw"`
	RH   int    `json:"rh"`
	Mode string `json:"mode"` // follow | center | fit
}

// Look is a 3x4 colour matrix (rows r,g,b: coefficient for r, g, b, then an
// offset in 0..1 units), plus vignette and sharpen amounts in 0..1. The same
// matrix drives the browser preview through an SVG feColorMatrix.
type Look struct {
	Matrix   []float64 `json:"matrix"`
	Vignette float64   `json:"vignette"`
	Sharpen  float64   `json:"sharpen"`
}

type Trim struct {
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

func (o OutputSpec) Label() string { return fmt.Sprintf("%d:%d", o.RW, o.RH) }

func (p PathData) At(t float64) (float64, float64) {
	n := len(p.X)
	if n == 0 || len(p.Y) != n || p.Rate <= 0 {
		return 0.5, 0.5
	}
	i := clampInt(int(math.Round(t*p.Rate)), 0, n-1)
	return p.X[i], p.Y[i]
}

func (l Look) identity() bool {
	if len(l.Matrix) != 12 {
		return true
	}
	id := []float64{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0}
	for i, v := range l.Matrix {
		if math.Abs(v-id[i]) > 1e-4 {
			return false
		}
	}
	return true
}

func (s *RenderSpec) validate(src *SourceInfo) error {
	if len(s.Outputs) == 0 {
		return errors.New("pick at least one shape to export")
	}
	for _, o := range s.Outputs {
		if o.RW <= 0 || o.RH <= 0 || o.RW > 100 || o.RH > 100 {
			return fmt.Errorf("shape %d:%d isn't valid", o.RW, o.RH)
		}
		switch o.Mode {
		case "follow", "center", "fit":
		default:
			return fmt.Errorf("unknown framing %q", o.Mode)
		}
	}
	switch s.Size {
	case "native", "1080", "1440", "2160":
	default:
		return fmt.Errorf("unknown size %q", s.Size)
	}
	switch s.Enhance {
	case "off", "fast", "ai", "cloud":
	default:
		return fmt.Errorf("unknown enhance mode %q", s.Enhance)
	}
	switch s.Quality {
	case "high", "prores", "lossless":
	default:
		return fmt.Errorf("unknown file type %q", s.Quality)
	}
	if len(s.Look.Matrix) != 0 && len(s.Look.Matrix) != 12 {
		return errors.New("look matrix must have 12 numbers")
	}
	for _, v := range s.Look.Matrix {
		if math.IsNaN(v) || v < -8 || v > 8 {
			return errors.New("look matrix values must be between -8 and 8")
		}
	}
	if s.Trim != nil {
		if s.Trim.Start < 0 || s.Trim.End <= s.Trim.Start+0.05 || s.Trim.Start >= src.Duration {
			return errors.New("the trimmed range is empty")
		}
	}
	return nil
}

// --- geometry --------------------------------------------------------------

func evenRound(v float64) int {
	n := int(math.Round(v/2)) * 2
	if n < 2 {
		n = 2
	}
	return n
}

func evenCeil(v float64) int {
	n := int(math.Ceil(v))
	return n + n%2
}

// cropWindow is the largest rw:rh rectangle that fits inside the source.
func cropWindow(W, H, rw, rh int) (int, int) {
	a := float64(rw) / float64(rh)
	if float64(W)/float64(H) >= a {
		h := H &^ 1
		w := evenRound(float64(h) * a)
		if w > W {
			w = W &^ 1
		}
		return w, h
	}
	w := W &^ 1
	h := evenRound(float64(w) / a)
	if h > H {
		h = H &^ 1
	}
	return w, h
}

// fitCanvas is the smallest rw:rh canvas that holds the whole source without
// resampling it, so "Original pixels" keeps every source pixel.
func fitCanvas(W, H, rw, rh int) (int, int) {
	a := float64(rw) / float64(rh)
	if float64(W)/float64(H) >= a {
		w := evenCeil(float64(W))
		return w, evenCeil(float64(w) / a)
	}
	h := evenCeil(float64(H))
	return evenCeil(float64(h) * a), h
}

var sizeShortSide = map[string]int{"1080": 1080, "1440": 1440, "2160": 2160}

func outputDims(nativeW, nativeH, rw, rh int, size string) (int, int) {
	s, ok := sizeShortSide[size]
	if !ok {
		return nativeW, nativeH
	}
	a := float64(rw) / float64(rh)
	if a >= 1 {
		return evenRound(float64(s) * a), s
	}
	return s, evenRound(float64(s) / a)
}

// Plan is the resolved geometry for one output.
type Plan struct {
	Src        *SourceInfo
	Out        OutputSpec
	WinW, WinH int // crop window, or the fit canvas
	OutW, OutH int
	Start, Dur float64
}

func planFor(src *SourceInfo, out OutputSpec, size string, trim *Trim) Plan {
	p := Plan{Src: src, Out: out, Start: 0, Dur: src.Duration}
	if out.Mode == "fit" {
		p.WinW, p.WinH = fitCanvas(src.Width, src.Height, out.RW, out.RH)
	} else {
		p.WinW, p.WinH = cropWindow(src.Width, src.Height, out.RW, out.RH)
	}
	p.OutW, p.OutH = outputDims(p.WinW, p.WinH, out.RW, out.RH, size)
	if trim != nil {
		p.Start = clamp(trim.Start, 0, src.Duration)
		p.Dur = clamp(trim.End, p.Start, src.Duration) - p.Start
	}
	return p
}

// cropAt is the window's top-left at source time t, kept inside the frame and
// on even pixels so 4:2:0 chroma isn't shifted.
func (p Plan) cropAt(path PathData, t float64) (int, int) {
	cx, cy := 0.5, 0.5
	if p.Out.Mode == "follow" {
		cx, cy = path.At(t)
	}
	W, H := p.Src.Width, p.Src.Height
	x := int(math.Round(cx*float64(W) - float64(p.WinW)/2))
	y := int(math.Round(cy*float64(H) - float64(p.WinH)/2))
	return clampInt(x, 0, W-p.WinW) &^ 1, clampInt(y, 0, H-p.WinH) &^ 1
}

// cropCommands moves the crop window frame by frame through ffmpeg's sendcmd.
// Times are on the output timeline, which starts at 0 after the input seek.
func (p Plan) cropCommands(path PathData) string {
	fps := p.Src.FPS
	n := int(math.Ceil(p.Dur*fps)) + int(fps) // a second of slack for VFR drift
	var b strings.Builder
	px, py := -1, -1
	for i := 0; i < n; i++ {
		t := float64(i) / fps
		x, y := p.cropAt(path, p.Start+t)
		if x == px && y == py {
			continue
		}
		px, py = x, y
		at := math.Max(0, t-0.5/fps)
		fmt.Fprintf(&b, "%.4f [enter] crop@rf x %d, [enter] crop@rf y %d;\n", at, x, y)
	}
	return b.String()
}

// --- filter graphs ---------------------------------------------------------

// stage1 turns the source into the framed picture at native resolution:
// a moving crop, a fixed centre crop, or the whole frame over a blurred fill.
func (p Plan) stage1(in, out string, path PathData, cmdFile string, at float64) string {
	switch {
	case p.Out.Mode == "fit":
		bw, bh := evenRound(float64(p.WinW)/4), evenRound(float64(p.WinH)/4)
		return fmt.Sprintf("[%s]split=2[bg][fg];"+
			"[bg]scale=%d:%d:force_original_aspect_ratio=increase:flags=bilinear,crop=%d:%d,gblur=sigma=10,scale=%d:%d:flags=bicubic,setsar=1[bgb];"+
			"[bgb][fg]overlay=x=(W-w)/2:y=(H-h)/2:format=auto,setsar=1[%s]",
			in, bw, bh, bw, bh, p.WinW, p.WinH, out)
	case cmdFile != "":
		x, y := p.cropAt(path, p.Start)
		return fmt.Sprintf("[%s]sendcmd=f=%s,crop@rf=w=%d:h=%d:x=%d:y=%d,setsar=1[%s]", in, cmdFile, p.WinW, p.WinH, x, y, out)
	default:
		x, y := p.cropAt(path, at)
		return fmt.Sprintf("[%s]crop=w=%d:h=%d:x=%d:y=%d,setsar=1[%s]", in, p.WinW, p.WinH, x, y, out)
	}
}

type stage2Opts struct {
	InW, InH int
	InputRGB bool // frames coming back from the AI upscaler
	Enhance  string
	Look     Look
	OutPix   string
}

// stage2 scales to the export size and applies the look. Colour work happens
// in RGB with explicit matrices so a no-op look is truly a no-op.
func (p Plan) stage2(o stage2Opts) string {
	m, r := p.Src.colorMatrix(), p.Src.colorRange()
	// 16 bits per channel while grading: no banding from the matrix steps.
	const rgba = "rgba64le"
	var f []string
	if o.Enhance == "fast" && !o.InputRGB {
		f = append(f, "hqdn3d=1.5:1.5:4:4")
	}
	// Every scale that could change between YUV and RGB names its matrix and
	// is followed by a format pin, so ffmpeg never picks a default matrix.
	var resize []string
	if o.InW != p.OutW || o.InH != p.OutH {
		flags := "lanczos+accurate_rnd+full_chroma_int"
		if o.InW > p.OutW*2 {
			flags = "area+accurate_rnd" // big AI frames: area downscale avoids ringing
		}
		resize = []string{fmt.Sprintf("%d:%d", p.OutW, p.OutH), "flags=" + flags}
	}
	scale := func(opts ...string) string { return "scale=" + strings.Join(opts, ":") }
	toYUV := fmt.Sprintf("out_color_matrix=%s:out_range=%s", m, r)
	needLook := !o.Look.identity()
	switch {
	case !o.InputRGB && !needLook:
		if resize != nil {
			f = append(f, scale(resize...))
		}
	case !o.InputRGB && needLook:
		in := fmt.Sprintf("in_color_matrix=%s:in_range=%s", m, r)
		f = append(f, scale(append(resize, in)...), "format="+rgba, colorMixer(o.Look.Matrix), scale(toYUV))
	case o.InputRGB && !needLook:
		f = append(f, scale(append(resize, toYUV)...))
	default:
		if resize != nil {
			f = append(f, scale(resize...))
		}
		f = append(f, "format="+rgba, colorMixer(o.Look.Matrix), scale(toYUV))
	}
	f = append(f, "format="+o.OutPix)
	if o.Look.Vignette > 0.001 {
		f = append(f, fmt.Sprintf("vignette=angle=%.4f:aspect=1", 0.2+0.6*clamp(o.Look.Vignette, 0, 1)))
	}
	sharpen := 1.5 * clamp(o.Look.Sharpen, 0, 1)
	if o.Enhance == "fast" {
		sharpen += 0.7
	}
	if sharpen > 0.001 {
		f = append(f, fmt.Sprintf("unsharp=5:5:%.3f:5:5:0", sharpen))
	}
	if f[len(f)-1] != "format="+o.OutPix {
		f = append(f, "format="+o.OutPix)
	}
	f = append(f, p.Src.colorTagFilter())
	return strings.Join(f, ",")
}

// colorMixer applies the look matrix. colorchannelmixer only takes values in
// -2..2, so a stronger matrix M runs as M/k followed by gain steps of at most
// 2. Each step is linear and clamps the same way, so the result equals M.
func colorMixer(m []float64) string {
	maxAbs := 0.0
	for _, v := range m {
		maxAbs = math.Max(maxAbs, math.Abs(v))
	}
	k := 1.0
	if maxAbs > 1.95 {
		k = maxAbs / 1.9
	}
	s := make([]float64, 12)
	for i, v := range m {
		s[i] = v / k
	}
	// The alpha term doubles as the constant offset: frames are opaque (a=1),
	// so ra*a adds ra, matching feColorMatrix's offset column exactly.
	parts := []string{fmt.Sprintf("colorchannelmixer=rr=%.5f:rg=%.5f:rb=%.5f:ra=%.5f:gr=%.5f:gg=%.5f:gb=%.5f:ga=%.5f:br=%.5f:bg=%.5f:bb=%.5f:ba=%.5f:ar=0:ag=0:ab=0:aa=1",
		s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9], s[10], s[11])}
	for k > 1.0001 {
		g := math.Min(k, 2)
		parts = append(parts, fmt.Sprintf("colorchannelmixer=rr=%.5f:gg=%.5f:bb=%.5f", g, g, g))
		k /= g
	}
	return strings.Join(parts, ",")
}

// --- encoding --------------------------------------------------------------

type encoding struct {
	Video  []string
	Audio  []string
	OutPix string
	Ext    string
}

func encodingFor(quality string, src *SourceInfo, eightBitInput bool) encoding {
	tags := src.colorTags()
	switch quality {
	case "prores":
		return encoding{
			Video:  append([]string{"-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0"}, tags...),
			Audio:  []string{"-c:a", "pcm_s16le"},
			OutPix: "yuv422p10le", Ext: ".mov",
		}
	case "lossless":
		pix := "yuv444p"
		if !eightBitInput && (strings.HasPrefix(src.PixFmt, "yuv") || strings.HasPrefix(src.PixFmt, "gray")) && !strings.HasPrefix(src.PixFmt, "yuvj") {
			pix = src.PixFmt
		}
		return encoding{
			Video:  append([]string{"-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "16", "-slicecrc", "1"}, tags...),
			Audio:  []string{"-c:a", "flac"},
			OutPix: pix, Ext: ".mkv",
		}
	}
	if src.BitDepth > 8 && !eightBitInput {
		// 10-bit (often HDR phone video): HEVC keeps the extra precision and HDR tags.
		return encoding{
			Video:  append([]string{"-c:v", "libx265", "-preset", "medium", "-crf", "16", "-tag:v", "hvc1", "-x265-params", "log-level=error", "-movflags", "+faststart"}, tags...),
			Audio:  []string{"-c:a", "aac", "-b:a", "320k"},
			OutPix: "yuv420p10le", Ext: ".mp4",
		}
	}
	return encoding{
		Video:  append([]string{"-c:v", "libx264", "-preset", "slow", "-crf", "14", "-profile:v", "high", "-movflags", "+faststart"}, tags...),
		Audio:  []string{"-c:a", "aac", "-b:a", "320k"},
		OutPix: "yuv420p", Ext: ".mp4",
	}
}

func (p Plan) trimInput() []string {
	if p.Start <= 0 && p.Dur >= p.Src.Duration {
		return nil
	}
	return []string{"-ss", fmt.Sprintf("%.4f", p.Start), "-t", fmt.Sprintf("%.4f", p.Dur)}
}
