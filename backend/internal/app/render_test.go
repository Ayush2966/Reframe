package app

import (
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func TestCropWindow(t *testing.T) {
	cases := []struct {
		W, H, rw, rh, w, h int
	}{
		{1920, 1080, 9, 16, 608, 1080},
		{1920, 1080, 4, 5, 864, 1080},
		{1920, 1080, 1, 1, 1080, 1080},
		{1920, 1080, 4, 3, 1440, 1080},
		{1920, 1080, 16, 9, 1920, 1080},
		{1080, 1920, 16, 9, 1080, 608},
		{1080, 1920, 4, 3, 1080, 810},
		{3840, 2160, 9, 16, 1216, 2160},
		{1921, 1081, 9, 16, 608, 1080}, // odd sizes stay even and inside
	}
	for _, c := range cases {
		w, h := cropWindow(c.W, c.H, c.rw, c.rh)
		if w != c.w || h != c.h {
			t.Errorf("cropWindow(%dx%d, %d:%d) = %dx%d, want %dx%d", c.W, c.H, c.rw, c.rh, w, h, c.w, c.h)
		}
		if w > c.W || h > c.H || w%2 != 0 || h%2 != 0 {
			t.Errorf("cropWindow(%dx%d, %d:%d) = %dx%d is outside the frame or odd", c.W, c.H, c.rw, c.rh, w, h)
		}
	}
}

func TestFitCanvasKeepsEverySourcePixel(t *testing.T) {
	cases := []struct{ W, H, rw, rh, w, h int }{
		{1080, 1920, 16, 9, 3414, 1920},
		{1920, 1080, 9, 16, 1920, 3414},
		{1920, 1080, 1, 1, 1920, 1920},
	}
	for _, c := range cases {
		w, h := fitCanvas(c.W, c.H, c.rw, c.rh)
		if w != c.w || h != c.h {
			t.Errorf("fitCanvas(%dx%d, %d:%d) = %dx%d, want %dx%d", c.W, c.H, c.rw, c.rh, w, h, c.w, c.h)
		}
	}
}

func TestOutputDims(t *testing.T) {
	cases := []struct {
		rw, rh int
		size   string
		w, h   int
	}{
		{9, 16, "1080", 1080, 1920},
		{4, 5, "1080", 1080, 1350},
		{1, 1, "1080", 1080, 1080},
		{16, 9, "1080", 1920, 1080},
		{4, 3, "1080", 1440, 1080},
		{9, 16, "2160", 2160, 3840},
		{9, 16, "native", 608, 1080},
	}
	for _, c := range cases {
		w, h := outputDims(608, 1080, c.rw, c.rh, c.size)
		if w != c.w || h != c.h {
			t.Errorf("outputDims(%d:%d, %s) = %dx%d, want %dx%d", c.rw, c.rh, c.size, w, h, c.w, c.h)
		}
	}
}

func TestCropAtFollowsPathAndStaysInside(t *testing.T) {
	src := &SourceInfo{Width: 1920, Height: 1080, Duration: 2, FPS: 10}
	plan := planFor(src, OutputSpec{RW: 9, RH: 16, Mode: "follow"}, "native", nil)
	path := PathData{Rate: 10, X: []float64{0, 0.5, 1}, Y: []float64{0.5, 0.5, 0.5}}

	if x, y := plan.cropAt(path, 0); x != 0 || y != 0 {
		t.Errorf("left edge: got %d,%d want 0,0", x, y)
	}
	if x, _ := plan.cropAt(path, 0.1); x != 656 { // 960 - 304
		t.Errorf("centre: got x=%d want 656", x)
	}
	if x, _ := plan.cropAt(path, 0.2); x != 1312 { // 1920 - 608
		t.Errorf("right edge: got x=%d want 1312", x)
	}
	if x, _ := plan.cropAt(path, 99); x != 1312 {
		t.Errorf("past the end should hold the last sample, got x=%d", x)
	}

	center := planFor(src, OutputSpec{RW: 9, RH: 16, Mode: "center"}, "native", nil)
	if x, _ := center.cropAt(path, 0); x != 656 {
		t.Errorf("centre mode ignores the path, got x=%d want 656", x)
	}
}

func TestCropCommandsOnlyWhenPositionChanges(t *testing.T) {
	src := &SourceInfo{Width: 1920, Height: 1080, Duration: 1, FPS: 10}
	plan := planFor(src, OutputSpec{RW: 9, RH: 16, Mode: "follow"}, "native", nil)
	still := PathData{Rate: 10, X: make([]float64, 11), Y: make([]float64, 11)}
	for i := range still.X {
		still.X[i], still.Y[i] = 0.5, 0.5
	}
	if n := strings.Count(plan.cropCommands(still), "\n"); n != 1 {
		t.Errorf("a still path should produce one command, got %d", n)
	}
}

func TestStage2NoLookNoScaleIsPassthrough(t *testing.T) {
	src := &SourceInfo{Width: 1920, Height: 1080, Duration: 1, FPS: 30, BitDepth: 8}
	plan := planFor(src, OutputSpec{RW: 9, RH: 16, Mode: "follow"}, "native", nil)
	got := plan.stage2(stage2Opts{InW: plan.WinW, InH: plan.WinH, Enhance: "off", OutPix: "yuv420p"})
	if got != "format=yuv420p,setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv" {
		t.Errorf("expected only a format pin and colour tags, got %q", got)
	}
}

func TestStage2LookUsesSourceMatrix(t *testing.T) {
	src := &SourceInfo{Width: 1920, Height: 1080, Duration: 1, FPS: 30, BitDepth: 8} // untagged HD
	plan := planFor(src, OutputSpec{RW: 9, RH: 16, Mode: "follow"}, "1080", nil)
	look := Look{Matrix: []float64{1.1, 0, 0, 0.02, 0, 1, 0, 0, 0, 0, 0.9, 0}}
	got := plan.stage2(stage2Opts{InW: plan.WinW, InH: plan.WinH, Look: look, OutPix: "yuv420p"})
	for _, want := range []string{
		"scale=1080:1920:flags=lanczos+accurate_rnd+full_chroma_int:in_color_matrix=bt709:in_range=tv",
		"format=rgba64le",
		"colorchannelmixer=rr=1.10000",
		"ra=0.02000",
		"scale=out_color_matrix=bt709:out_range=tv",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("stage2 missing %q in %q", want, got)
		}
	}
}

func TestValidateRejectsBadSpecs(t *testing.T) {
	src := &SourceInfo{Width: 1920, Height: 1080, Duration: 10, FPS: 30}
	ok := RenderSpec{Outputs: []OutputSpec{{RW: 9, RH: 16, Mode: "follow"}}, Size: "native", Enhance: "off", Quality: "high"}
	if err := ok.validate(src); err != nil {
		t.Fatalf("valid spec rejected: %v", err)
	}
	bad := []func(s *RenderSpec){
		func(s *RenderSpec) { s.Outputs = nil },
		func(s *RenderSpec) { s.Outputs[0].Mode = "zoom" },
		func(s *RenderSpec) { s.Size = "8k" },
		func(s *RenderSpec) { s.Look.Matrix = []float64{1} },
		func(s *RenderSpec) { s.Trim = &Trim{Start: 5, End: 5} },
	}
	for i, mutate := range bad {
		s := ok
		s.Outputs = append([]OutputSpec{}, ok.Outputs...)
		mutate(&s)
		if s.validate(src) == nil {
			t.Errorf("bad spec %d was accepted", i)
		}
	}
}

func TestStrongLookSplitsIntoValidMixers(t *testing.T) {
	m := []float64{3.2, -0.5, -0.2, -0.3, -0.4, 3, -0.3, -0.3, -0.2, -0.6, 3.1, -0.3}
	got := colorMixer(m)
	re := regexp.MustCompile(`=(-?[0-9.]+)`)
	for _, v := range re.FindAllStringSubmatch(got, -1) {
		f, _ := strconv.ParseFloat(v[1], 64)
		if f < -2 || f > 2 {
			t.Fatalf("value %v out of colorchannelmixer range in %q", f, got)
		}
	}
	if strings.Count(got, "colorchannelmixer") != 2 {
		t.Errorf("expected the matrix plus one gain step, got %q", got)
	}
}
