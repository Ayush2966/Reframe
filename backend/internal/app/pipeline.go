package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// renderer runs one output of a RenderSpec into a file inside workDir.
type renderer struct {
	cfg      *Config
	src      string // absolute path of the source video
	plan     Plan
	spec     RenderSpec
	workDir  string
	progress func(stage string, frac float64, eta time.Duration)
}

func (r *renderer) output(ext string) string { return filepath.Join(r.workDir, "output"+ext) }

func (r *renderer) run(ctx context.Context) (string, error) {
	switch r.spec.Enhance {
	case "ai":
		return r.runAI(ctx)
	case "cloud":
		return r.runCloud(ctx)
	}
	return r.runSinglePass(ctx)
}

// stage1 writes the crop commands (when following) and returns the graph.
func (r *renderer) stage1(in, out string) (string, error) {
	cmdFile := ""
	if r.plan.Out.Mode == "follow" {
		cmdFile = "crop.cmd"
		if err := os.WriteFile(filepath.Join(r.workDir, cmdFile), []byte(r.plan.cropCommands(r.spec.Path)), 0o644); err != nil {
			return "", err
		}
	}
	return r.plan.stage1(in, out, r.spec.Path, cmdFile, r.plan.Start), nil
}

func (r *renderer) audioMap(input int, enc encoding) []string {
	if !r.plan.Src.HasAudio {
		return nil
	}
	return append([]string{"-map", fmt.Sprintf("%d:a:0?", input)}, enc.Audio...)
}

func (r *renderer) runSinglePass(ctx context.Context) (string, error) {
	enc := encodingFor(r.spec.Quality, r.plan.Src, false)
	s1, err := r.stage1("0:v", "s1")
	if err != nil {
		return "", err
	}
	s2 := r.plan.stage2(stage2Opts{InW: r.plan.WinW, InH: r.plan.WinH, Enhance: r.spec.Enhance, Look: r.spec.Look, OutPix: enc.OutPix})
	out := r.output(enc.Ext)

	args := append(append(r.plan.trimInput(), safeInput(r.src)...), "-filter_complex", s1+";[s1]"+s2+"[out]", "-map", "[out]")
	args = append(args, r.audioMap(0, enc)...)
	args = append(args, enc.Video...)
	args = append(args, "-fps_mode", "passthrough", out)

	started := time.Now()
	r.progress("Rendering", 0, 0)
	err = ffmpegRun{Bin: r.cfg.FFmpeg, Dir: r.workDir, Args: args, Duration: r.plan.Dur, OnProgress: func(f float64) {
		r.progress("Rendering", f, eta(started, f))
	}}.Run(ctx)
	return out, err
}

func eta(started time.Time, frac float64) time.Duration {
	if frac < 0.02 {
		return 0
	}
	el := time.Since(started)
	return time.Duration(float64(el)/frac) - el
}

// runAI streams framed frames out of ffmpeg as PNGs, upscales them 4x with
// Real-ESRGAN in small batches, and streams the results into the encoder, so
// temp disk use stays at one batch no matter how long the video is.
func (r *renderer) runAI(ctx context.Context) (string, error) {
	if !r.cfg.AILocalAvailable() {
		return "", errors.New("the AI upscaler isn't installed. Run ./scripts/setup.sh")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	enc := encodingFor(r.spec.Quality, r.plan.Src, true)
	out := r.output(enc.Ext)
	fps := r.plan.Src.FPSRational
	total := int(r.plan.Dur*r.plan.Src.FPS + 0.5)
	if total < 1 {
		total = 1
	}

	// Decoder: framed picture as a PNG stream on stdout.
	s1, err := r.stage1("0:v", "s1")
	if err != nil {
		return "", err
	}
	m, rg := r.plan.Src.colorMatrix(), r.plan.Src.colorRange()
	decArgs := append([]string{"-hide_banner", "-nostats", "-loglevel", "error"}, r.plan.trimInput()...)
	decArgs = append(append(decArgs, safeInput(r.src)...),
		"-filter_complex", fmt.Sprintf("%s;[s1]scale=in_color_matrix=%s:in_range=%s,format=rgb24[out]", s1, m, rg),
		"-map", "[out]", "-fps_mode", "cfr", "-r", fps, "-f", "image2pipe", "-c:v", "png", "-compression_level", "1", "pipe:1")
	dec := exec.CommandContext(ctx, r.cfg.FFmpeg, decArgs...)
	dec.Dir = r.workDir
	var decErr tailBuffer
	dec.Stderr = &decErr
	decOut, err := dec.StdoutPipe()
	if err != nil {
		return "", err
	}
	if err := dec.Start(); err != nil {
		return "", err
	}
	decWaited := false
	defer func() {
		if !decWaited {
			cancel()
			_ = dec.Wait()
		}
	}()

	// Encoder: upscaled PNGs in, final file out (audio from the source).
	s2 := r.plan.stage2(stage2Opts{InW: r.plan.WinW * 4, InH: r.plan.WinH * 4, InputRGB: true, Look: r.spec.Look, OutPix: enc.OutPix})
	encArgs := []string{"-f", "image2pipe", "-framerate", fps, "-c:v", "png", "-i", "pipe:0"}
	encArgs = append(encArgs, r.plan.trimInput()...)
	encArgs = append(append(encArgs, safeInput(r.src)...), "-filter_complex", "[0:v]"+s2+"[out]", "-map", "[out]")
	encArgs = append(encArgs, r.audioMap(1, enc)...)
	encArgs = append(encArgs, enc.Video...)
	encArgs = append(encArgs, "-shortest", out)
	pr, pw := io.Pipe()
	encDone := make(chan error, 1)
	go func() {
		err := ffmpegRun{Bin: r.cfg.FFmpeg, Dir: r.workDir, Args: encArgs, Stdin: pr}.Run(ctx)
		pr.CloseWithError(errors.New("encoder stopped"))
		encDone <- err
	}()

	bin, models := r.cfg.RealESRGAN()
	inDir, outDir := filepath.Join(r.workDir, "ai-in"), filepath.Join(r.workDir, "ai-out")
	defer os.RemoveAll(inDir)
	defer os.RemoveAll(outDir)

	reader := bufio.NewReaderSize(decOut, 1<<20)
	started := time.Now()
	done := 0
	const batch = 24
	r.progress("Enhancing with AI", 0, 0)
	for {
		if err := resetDir(inDir); err != nil {
			return "", err
		}
		if err := resetDir(outDir); err != nil {
			return "", err
		}
		n := 0
		for ; n < batch; n++ {
			png, err := readPNG(reader)
			if err == io.EOF {
				break
			}
			if err != nil {
				return "", fmt.Errorf("reading frames: %w (%s)", err, decErr.String())
			}
			if err := os.WriteFile(filepath.Join(inDir, fmt.Sprintf("%08d.png", done+n)), png, 0o644); err != nil {
				return "", err
			}
		}
		if n == 0 {
			break
		}
		up := exec.CommandContext(ctx, bin, "-i", inDir, "-o", outDir, "-n", AIModel, "-s", "4", "-m", models, "-f", "png")
		var upErr tailBuffer
		up.Stderr = &upErr
		if err := up.Run(); err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "", fmt.Errorf("AI upscaler failed: %s", upErr.String())
		}
		names, _ := filepath.Glob(filepath.Join(outDir, "*.png"))
		sort.Strings(names)
		if len(names) != n {
			return "", fmt.Errorf("AI upscaler returned %d of %d frames", len(names), n)
		}
		for _, name := range names {
			b, err := os.ReadFile(name)
			if err != nil {
				return "", err
			}
			if _, err := pw.Write(b); err != nil {
				return "", fmt.Errorf("encoder stopped early: %v", <-encDone)
			}
		}
		done += n
		frac := float64(done) / float64(total)
		if frac > 0.995 {
			frac = 0.995
		}
		r.progress(fmt.Sprintf("Enhancing with AI, frame %d of %d", done, total), frac, eta(started, frac))
	}
	decWaited = true
	if err := dec.Wait(); err != nil && ctx.Err() == nil {
		return "", fmt.Errorf("reading frames: %s", decErr.String())
	}
	pw.Close()
	r.progress("Finishing", 0.997, 0)
	if err := <-encDone; err != nil {
		return "", err
	}
	return out, nil
}

func resetDir(dir string) error {
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o755)
}

var pngSig = []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}

// readPNG reads one PNG image from a concatenated stream by walking its chunks.
func readPNG(r *bufio.Reader) ([]byte, error) {
	sig := make([]byte, 8)
	if _, err := io.ReadFull(r, sig); err != nil {
		if err == io.ErrUnexpectedEOF {
			return nil, io.EOF
		}
		return nil, err
	}
	if !bytes.Equal(sig, pngSig) {
		return nil, errors.New("not a PNG stream")
	}
	var buf bytes.Buffer
	buf.Write(sig)
	hdr := make([]byte, 8)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			return nil, fmt.Errorf("truncated PNG: %w", err)
		}
		buf.Write(hdr)
		n := int64(binary.BigEndian.Uint32(hdr[:4]))
		if _, err := io.CopyN(&buf, r, n+4); err != nil {
			return nil, fmt.Errorf("truncated PNG: %w", err)
		}
		if string(hdr[4:8]) == "IEND" {
			return buf.Bytes(), nil
		}
	}
}

// runCloud frames the video, sends it to Topaz Video Upscale on Replicate,
// then grades and encodes the result with the original audio.
func (r *renderer) runCloud(ctx context.Context) (string, error) {
	if r.cfg.ReplicateToken == "" {
		return "", errors.New("cloud enhance needs a Replicate API token. Add REPLICATE_API_TOKEN to .env and restart")
	}
	s1, err := r.stage1("0:v", "s1")
	if err != nil {
		return "", err
	}
	framed := filepath.Join(r.workDir, "framed.mp4")
	args := append(append(r.plan.trimInput(), safeInput(r.src)...), "-filter_complex", s1, "-map", "[s1]",
		"-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p",
		"-fps_mode", "cfr", "-r", r.plan.Src.FPSRational, "-an", framed)
	err = ffmpegRun{Bin: r.cfg.FFmpeg, Dir: r.workDir, Args: args, Duration: r.plan.Dur, OnProgress: func(f float64) {
		r.progress("Framing", 0.1*f, 0)
	}}.Run(ctx)
	if err != nil {
		return "", err
	}

	target := "1080p"
	if r.plan.OutW >= 2000 && r.plan.OutH >= 2000 || r.spec.Size == "2160" || r.spec.Size == "1440" {
		target = "4k"
	}
	upscaled := filepath.Join(r.workDir, "upscaled.mp4")
	rep := replicateClient{token: r.cfg.ReplicateToken}
	err = rep.upscaleVideo(ctx, framed, upscaled, target, int(r.plan.Src.FPS+0.5), func(stage string) {
		r.progress(stage, 0.15, 0)
	})
	if err != nil {
		return "", err
	}
	info, err := probe(ctx, r.cfg.FFprobe, upscaled)
	if err != nil {
		return "", fmt.Errorf("reading the upscaled video: %w", err)
	}

	enc := encodingFor(r.spec.Quality, r.plan.Src, true)
	out := r.output(enc.Ext)
	s2 := r.plan.stage2(stage2Opts{InW: info.Width, InH: info.Height, Look: r.spec.Look, OutPix: enc.OutPix})
	encArgs := safeInput(upscaled) // came back from the cloud: treat as untrusted
	encArgs = append(encArgs, r.plan.trimInput()...)
	encArgs = append(append(encArgs, safeInput(r.src)...), "-filter_complex", "[0:v]"+s2+"[out]", "-map", "[out]")
	encArgs = append(encArgs, r.audioMap(1, enc)...)
	encArgs = append(encArgs, enc.Video...)
	encArgs = append(encArgs, "-shortest", out)
	err = ffmpegRun{Bin: r.cfg.FFmpeg, Dir: r.workDir, Args: encArgs, Duration: r.plan.Dur, OnProgress: func(f float64) {
		r.progress("Encoding", 0.9+0.1*f, 0)
	}}.Run(ctx)
	return out, err
}

// renderFrame returns one exported frame as a PNG, exactly as the export
// would produce it, for checking the look and the enhancer before rendering.
func renderFrame(ctx context.Context, cfg *Config, src string, plan Plan, spec RenderSpec, t float64, tmpDir string) ([]byte, error) {
	m, rg := plan.Src.colorMatrix(), plan.Src.colorRange()
	toRGB := fmt.Sprintf("scale=in_color_matrix=%s:in_range=%s,format=rgb24", m, rg)
	s1 := plan.stage1("0:v", "s1", spec.Path, "", t)
	seek := fmt.Sprintf("%.4f", t)

	ff := func(args ...string) ([]byte, error) {
		full := append([]string{"-hide_banner", "-nostats", "-loglevel", "error", "-y"}, args...)
		cmd := exec.CommandContext(ctx, cfg.FFmpeg, full...)
		var stderr tailBuffer
		cmd.Stderr = &stderr
		out, err := cmd.Output()
		if err != nil {
			return nil, fmt.Errorf("ffmpeg failed: %s", stderr.String())
		}
		return out, nil
	}

	if spec.Enhance != "ai" {
		enhance := spec.Enhance
		if enhance == "cloud" {
			enhance = "off"
		}
		s2 := plan.stage2(stage2Opts{InW: plan.WinW, InH: plan.WinH, Enhance: enhance, Look: spec.Look, OutPix: "yuv444p"})
		return ff(append(append([]string{"-ss", seek}, safeInput(src)...), "-filter_complex", s1+";[s1]"+s2+","+toRGB+"[out]", "-map", "[out]",
			"-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1")...)
	}

	if !cfg.AILocalAvailable() {
		return nil, errors.New("the AI upscaler isn't installed. Run ./scripts/setup.sh")
	}
	inDir, outDir := filepath.Join(tmpDir, "in"), filepath.Join(tmpDir, "out")
	if err := resetDir(inDir); err != nil {
		return nil, err
	}
	if err := resetDir(outDir); err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpDir)
	framed, err := ff(append(append([]string{"-ss", seek}, safeInput(src)...), "-filter_complex", s1+";[s1]"+toRGB+"[out]", "-map", "[out]",
		"-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1")...)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(inDir, "f.png"), framed, 0o644); err != nil {
		return nil, err
	}
	bin, models := cfg.RealESRGAN()
	up := exec.CommandContext(ctx, bin, "-i", filepath.Join(inDir, "f.png"), "-o", filepath.Join(outDir, "f.png"), "-n", AIModel, "-s", "4", "-m", models)
	var upErr tailBuffer
	up.Stderr = &upErr
	if err := up.Run(); err != nil {
		return nil, fmt.Errorf("AI upscaler failed: %s", upErr.String())
	}
	s2 := plan.stage2(stage2Opts{InW: plan.WinW * 4, InH: plan.WinH * 4, InputRGB: true, Look: spec.Look, OutPix: "yuv444p"})
	return ff("-i", filepath.Join(outDir, "f.png"), "-filter_complex", "[0:v]"+s2+","+toRGB+"[out]", "-map", "[out]",
		"-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "pipe:1")
}

func labelForFile(o OutputSpec) string {
	return strings.ReplaceAll(o.Label(), ":", "x")
}
