package app

import (
	"bytes"
	"context"
	"image/png"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"
)

// These tests run real ffmpeg renders on small generated videos.

func testConfig(t *testing.T) *Config {
	t.Helper()
	cfg := &Config{ToolsDir: filepath.Join("..", "..", "..", "tools")}
	cfg.ResolveTools()
	if cfg.FFmpeg == "" {
		t.Skip("ffmpeg not installed")
	}
	return cfg
}

func makeVideo(t *testing.T, cfg *Config, lavfi string, extra ...string) (string, *SourceInfo) {
	t.Helper()
	out := filepath.Join(t.TempDir(), "src.mkv")
	args := append([]string{"-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", lavfi}, extra...)
	args = append(args, "-c:v", "ffv1", "-pix_fmt", "yuv420p", out)
	if b, err := exec.Command(cfg.FFmpeg, args...).CombinedOutput(); err != nil {
		t.Fatalf("making test video: %v\n%s", err, b)
	}
	info, err := probe(context.Background(), cfg.FFprobe, out)
	if err != nil {
		t.Fatal(err)
	}
	return out, info
}

func rawFrames(t *testing.T, cfg *Config, path string, w, h int) [][]byte {
	t.Helper()
	b, err := exec.Command(cfg.FFmpeg, "-hide_banner", "-loglevel", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "yuv420p", "-").Output()
	if err != nil {
		t.Fatalf("decoding %s: %v", path, err)
	}
	size := w * h * 3 / 2
	var frames [][]byte
	for len(b) >= size {
		frames = append(frames, b[:size])
		b = b[size:]
	}
	return frames
}

// cropYUV420 cuts a w×h window at (x,y) out of a W×H yuv420p frame.
func cropYUV420(f []byte, W, H, x, y, w, h int) []byte {
	out := make([]byte, 0, w*h*3/2)
	for r := 0; r < h; r++ {
		out = append(out, f[(y+r)*W+x:(y+r)*W+x+w]...)
	}
	cw, ch, cW := w/2, h/2, W/2
	for plane := 0; plane < 2; plane++ {
		base := W*H + plane*(W/2)*(H/2)
		for r := 0; r < ch; r++ {
			o := base + (y/2+r)*cW + x/2
			out = append(out, f[o:o+cw]...)
		}
	}
	return out
}

func runRender(t *testing.T, cfg *Config, src string, info *SourceInfo, spec RenderSpec) string {
	t.Helper()
	plan := planFor(info, spec.Outputs[0], spec.Size, spec.Trim)
	r := &renderer{cfg: cfg, src: src, plan: plan, spec: spec, workDir: t.TempDir(),
		progress: func(string, float64, time.Duration) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	out, err := r.run(ctx)
	if err != nil {
		t.Fatalf("render failed: %v", err)
	}
	return out
}

func linearPath(n int, rate float64) PathData {
	p := PathData{Rate: rate, X: make([]float64, n), Y: make([]float64, n)}
	for i := range p.X {
		p.X[i] = float64(i) / float64(n-1)
		p.Y[i] = 0.5
	}
	return p
}

func TestFollowRenderIsPixelExact(t *testing.T) {
	cfg := testConfig(t)
	src, info := makeVideo(t, cfg, "testsrc2=s=640x360:r=10:d=2")
	spec := RenderSpec{
		Path:    linearPath(21, 10),
		Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}},
		Size:    "native", Enhance: "off", Quality: "lossless",
	}
	out := runRender(t, cfg, src, info, spec)
	plan := planFor(info, spec.Outputs[0], "native", nil)

	srcFrames := rawFrames(t, cfg, src, 640, 360)
	outFrames := rawFrames(t, cfg, out, plan.WinW, plan.WinH)
	if len(outFrames) != len(srcFrames) {
		t.Fatalf("got %d frames, want %d", len(outFrames), len(srcFrames))
	}
	moved := map[int]bool{}
	for i, f := range outFrames {
		x, y := plan.cropAt(spec.Path, float64(i)/10)
		moved[x] = true
		want := cropYUV420(srcFrames[i], 640, 360, x, y, plan.WinW, plan.WinH)
		if !bytes.Equal(f, want) {
			t.Fatalf("frame %d differs from the source crop at x=%d", i, x)
		}
	}
	if len(moved) < 10 {
		t.Errorf("the window should move every frame, saw %d positions", len(moved))
	}
}

func TestTrimmedRenderStartsAtTrimPoint(t *testing.T) {
	cfg := testConfig(t)
	src, info := makeVideo(t, cfg, "testsrc2=s=640x360:r=10:d=2")
	spec := RenderSpec{
		Path:    linearPath(21, 10),
		Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}},
		Size:    "native", Enhance: "off", Quality: "lossless",
		Trim: &Trim{Start: 1, End: 1.5},
	}
	out := runRender(t, cfg, src, info, spec)
	plan := planFor(info, spec.Outputs[0], "native", spec.Trim)
	srcFrames := rawFrames(t, cfg, src, 640, 360)
	outFrames := rawFrames(t, cfg, out, plan.WinW, plan.WinH)
	if len(outFrames) != 5 {
		t.Fatalf("got %d frames, want 5", len(outFrames))
	}
	for i, f := range outFrames {
		x, y := plan.cropAt(spec.Path, 1+float64(i)/10)
		if !bytes.Equal(f, cropYUV420(srcFrames[10+i], 640, 360, x, y, plan.WinW, plan.WinH)) {
			t.Fatalf("trimmed frame %d doesn't match source frame %d at x=%d", i, 10+i, x)
		}
	}
}

func psnr(t *testing.T, cfg *Config, a, b string) float64 {
	t.Helper()
	// Tag both inputs the same so the psnr filter compares raw values instead
	// of converting one of them first.
	same := "[0:v]setparams=colorspace=bt709:range=tv[a];[1:v]setparams=colorspace=bt709:range=tv[b];[a][b]psnr"
	out, _ := exec.Command(cfg.FFmpeg, "-hide_banner", "-i", a, "-i", b, "-lavfi", same, "-f", "null", "-").CombinedOutput()
	m := regexp.MustCompile(`average:([0-9.]+|inf)`).FindSubmatch(out)
	if m == nil {
		t.Fatalf("no psnr in output:\n%s", out)
	}
	if string(m[1]) == "inf" {
		return 999
	}
	v, _ := strconv.ParseFloat(string(m[1]), 64)
	return v
}

// A look that changes almost nothing must not shift colours: the YUV->RGB->YUV
// round trip has to use the source's matrix (bt709 for HD, even untagged).
// The source is encoded with bt709 but left untagged, like many exports; read
// with the wrong matrix it scores ~35 dB, with the right one ~49 dB.
func TestNearIdentityLookDoesNotShiftColors(t *testing.T) {
	cfg := testConfig(t)
	src, info := makeVideo(t, cfg, "testsrc2=s=1280x720:r=10:d=0.5,format=rgb24,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p")
	base := RenderSpec{
		Path:    linearPath(6, 10),
		Outputs: []OutputSpec{{RW: 1, RH: 1, Mode: "center"}},
		Size:    "native", Enhance: "off", Quality: "lossless",
	}
	plain := runRender(t, cfg, src, info, base)
	graded := base
	graded.Look = Look{Matrix: []float64{1, 0, 0, 0.0005, 0, 1, 0, 0.0005, 0, 0, 1, 0.0005}}
	tinted := runRender(t, cfg, src, info, graded)
	if v := psnr(t, cfg, plain, tinted); v < 45 {
		t.Errorf("near-identity look changed the picture too much: PSNR %.1f dB", v)
	}

	// A matrix past ffmpeg's ±2 range (split into steps) must equal the same
	// grade done in one step: brightness 2.4 ≈ "x2 then x1.2".
	strong := base
	strong.Look = Look{Matrix: []float64{2.4, 0, 0, 0, 0, 2.4, 0, 0, 0, 0, 2.4, 0}}
	oneStep := base
	oneStep.Look = Look{Matrix: []float64{1.2, 0, 0, 0, 0, 1.2, 0, 0, 0, 0, 1.2, 0}}
	a := runRender(t, cfg, src, info, strong)
	b := runRender(t, cfg, src, info, oneStep)
	if v := psnr(t, cfg, a, b); v > 30 {
		t.Errorf("x2.4 should look clearly brighter than x1.2 (PSNR %.1f)", v)
	}
}

func TestFitModeKeepsWholeFrame(t *testing.T) {
	cfg := testConfig(t)
	src, info := makeVideo(t, cfg, "testsrc2=s=270x480:r=10:d=0.5")
	spec := RenderSpec{
		Outputs: []OutputSpec{{RW: 16, RH: 9, Mode: "fit"}},
		Size:    "native", Enhance: "off", Quality: "high",
	}
	out := runRender(t, cfg, src, info, spec)
	got, err := probe(context.Background(), cfg.FFprobe, out)
	if err != nil {
		t.Fatal(err)
	}
	if got.Width != 854 || got.Height != 480 {
		t.Errorf("fit canvas is %dx%d, want 854x480", got.Width, got.Height)
	}
}

func TestFastEnhanceUpscalesWithAudio(t *testing.T) {
	cfg := testConfig(t)
	out := filepath.Join(t.TempDir(), "src.mp4")
	if b, err := exec.Command(cfg.FFmpeg, "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=s=640x360:r=10:d=1", "-f", "lavfi", "-i", "sine=d=1",
		"-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", out).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	info, _ := probe(context.Background(), cfg.FFprobe, out)
	spec := RenderSpec{
		Path:    linearPath(11, 10),
		Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}},
		Size:    "1080", Enhance: "fast", Quality: "high",
		Look: Look{Matrix: []float64{1.1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.9, 0}, Vignette: 0.5, Sharpen: 0.3},
	}
	res := runRender(t, cfg, out, info, spec)
	got, err := probe(context.Background(), cfg.FFprobe, res)
	if err != nil {
		t.Fatal(err)
	}
	if got.Width != 1080 || got.Height != 1920 || !got.HasAudio {
		t.Errorf("got %dx%d audio=%v, want 1080x1920 with audio", got.Width, got.Height, got.HasAudio)
	}
}

func TestAIRenderStreamsFramesThroughUpscaler(t *testing.T) {
	cfg := testConfig(t)
	if !cfg.AILocalAvailable() {
		t.Skip("Real-ESRGAN not installed (run scripts/setup.sh)")
	}
	src, info := makeVideo(t, cfg, "testsrc2=s=320x180:r=10:d=3")
	spec := RenderSpec{
		Path:    linearPath(31, 10),
		Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}},
		Size:    "1080", Enhance: "ai", Quality: "high",
	}
	out := runRender(t, cfg, src, info, spec)
	got, err := probe(context.Background(), cfg.FFprobe, out)
	if err != nil {
		t.Fatal(err)
	}
	if got.Width != 1080 || got.Height != 1920 {
		t.Errorf("AI output is %dx%d, want 1080x1920", got.Width, got.Height)
	}
	frames, _ := exec.Command(cfg.FFprobe, "-v", "error", "-count_frames", "-select_streams", "v:0",
		"-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", out).Output()
	if n, _ := strconv.Atoi(string(bytes.TrimSpace(frames))); n != 30 {
		t.Errorf("AI output has %d frames, want 30 (more than one batch)", n)
	}
}

func TestHDRSourceKeepsTenBitsAndTags(t *testing.T) {
	cfg := testConfig(t)
	src := filepath.Join(t.TempDir(), "hdr.mp4")
	if b, err := exec.Command(cfg.FFmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi",
		"-i", "testsrc2=s=640x360:r=10:d=0.5,format=yuv420p10le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=arib-std-b67",
		"-c:v", "libx265", "-x265-params", "log-level=error", src).CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, b)
	}
	info, _ := probe(context.Background(), cfg.FFprobe, src)
	if !info.HDR || info.BitDepth != 10 {
		t.Fatalf("test source should be 10-bit HLG, got %+v", info)
	}
	spec := RenderSpec{
		Path:    linearPath(6, 10),
		Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}},
		Size:    "1080", Enhance: "off", Quality: "high",
		Look: Look{Matrix: []float64{1.05, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0}, Vignette: 0.3},
	}
	got, err := probe(context.Background(), cfg.FFprobe, runRender(t, cfg, src, info, spec))
	if err != nil {
		t.Fatal(err)
	}
	if got.BitDepth != 10 || got.ColorTransfer != "arib-std-b67" || got.ColorSpace != "bt2020nc" {
		t.Errorf("HDR lost: %d-bit transfer=%s space=%s", got.BitDepth, got.ColorTransfer, got.ColorSpace)
	}
}

func TestRenderFrameMatchesExportSize(t *testing.T) {
	cfg := testConfig(t)
	src, info := makeVideo(t, cfg, "testsrc2=s=640x360:r=10:d=1")
	spec := RenderSpec{
		Path:    linearPath(11, 10),
		Outputs: []OutputSpec{{RW: 4, RH: 5, Mode: "follow"}},
		Size:    "1080", Enhance: "fast", Quality: "high",
	}
	plan := planFor(info, spec.Outputs[0], spec.Size, nil)
	b, err := renderFrame(context.Background(), cfg, src, plan, spec, 0.5, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	img, err := png.Decode(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if s := img.Bounds().Size(); s.X != 1080 || s.Y != 1350 {
		t.Errorf("preview frame is %v, want 1080x1350", s)
	}
	_ = os.Remove(src)
}

// A "video" that is really a playlist or a concat script must not make ffmpeg
// open other files (local file disclosure via HLS/ffconcat).
func TestPlaylistsPosingAsVideosAreRejected(t *testing.T) {
	cfg := testConfig(t)
	dir := t.TempDir()
	segment, _ := makeVideo(t, cfg, "testsrc2=s=64x64:r=10:d=0.2")
	cases := map[string]string{
		"evil.m3u8": "#EXTM3U\n#EXTINF:1.0,\nfile://" + segment + "\n#EXT-X-ENDLIST\n",
		"evil.mp4":  "ffconcat version 1.0\nfile " + filepath.Base(segment) + "\n",
	}
	for name, body := range cases {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := probe(context.Background(), cfg.FFprobe, path); err == nil {
			t.Errorf("%s was accepted as a video", name)
		}
		args := append(append([]string{"-hide_banner", "-loglevel", "error"}, safeInput(path)...), "-f", "null", "-")
		if exec.Command(cfg.FFmpeg, args...).Run() == nil {
			t.Errorf("ffmpeg read %s through the guards", name)
		}
	}
}
