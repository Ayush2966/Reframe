package app

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Project struct {
	ID         string      `json:"id"`
	Name       string      `json:"name"`
	CreatedAt  time.Time   `json:"createdAt"`
	Status     string      `json:"status"` // importing | ready | error
	Stage      string      `json:"stage,omitempty"`
	Progress   float64     `json:"progress"`
	Error      string      `json:"error,omitempty"`
	Origin     string      `json:"origin,omitempty"`
	SourceFile string      `json:"sourceFile,omitempty"`
	Source     *SourceInfo `json:"source,omitempty"`
}

type ProjectStore struct {
	dir string
	mu  sync.Mutex
	all map[string]*Project
}

func newProjectStore(dir string) (*ProjectStore, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &ProjectStore{dir: dir, all: map[string]*Project{}}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		var p Project
		if !e.IsDir() || readJSONFile(filepath.Join(dir, e.Name(), "project.json"), &p) != nil {
			continue
		}
		if p.Status == "importing" {
			p.Status, p.Error = "error", "The import stopped because the app was closed. Import the video again."
		}
		s.all[p.ID] = &p
	}
	return s, nil
}

func (s *ProjectStore) Dir(id string) string { return filepath.Join(s.dir, id) }

func (s *ProjectStore) Create(name, origin string) (*Project, error) {
	p := &Project{ID: newID(), Name: name, CreatedAt: time.Now(), Status: "importing", Origin: origin}
	if err := os.MkdirAll(s.Dir(p.ID), 0o755); err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.all[p.ID] = p
	s.mu.Unlock()
	return p, s.save(p)
}

func (s *ProjectStore) Get(id string) (Project, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.all[id]
	if !ok {
		return Project{}, false
	}
	return *p, true
}

func (s *ProjectStore) List() []Project {
	s.mu.Lock()
	out := make([]Project, 0, len(s.all))
	for _, p := range s.all {
		out = append(out, *p)
	}
	s.mu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out
}

// Update applies fn under the lock and persists. Progress-only updates skip
// the disk write to avoid hammering it during long imports.
func (s *ProjectStore) Update(id string, persist bool, fn func(p *Project)) {
	s.mu.Lock()
	p, ok := s.all[id]
	if !ok {
		s.mu.Unlock()
		return
	}
	fn(p)
	cp := *p
	s.mu.Unlock()
	if persist {
		_ = s.save(&cp)
	}
}

func (s *ProjectStore) Delete(id string) error {
	s.mu.Lock()
	delete(s.all, id)
	s.mu.Unlock()
	return os.RemoveAll(s.Dir(id))
}

func (s *ProjectStore) save(p *Project) error {
	return writeJSONFile(filepath.Join(s.Dir(p.ID), "project.json"), p)
}

func (s *ProjectStore) fail(id string, err error) {
	log.Printf("project %s: %v", id, err)
	s.Update(id, true, func(p *Project) {
		p.Status, p.Stage, p.Error = "error", "", err.Error()
	})
}

// --- importing -------------------------------------------------------------

// prepare probes the source and builds the browser preview (proxy) used for
// playback and subject tracking. Renders always read the original file.
func (a *App) prepare(id string) {
	defer keepAwake()()
	ctx := context.Background()
	p, _ := a.projects.Get(id)
	dir := a.projects.Dir(id)
	src := filepath.Join(dir, p.SourceFile)

	a.projects.Update(id, true, func(p *Project) { p.Stage, p.Progress = "Reading video", 0 })
	info, err := probe(ctx, a.cfg.FFprobe, src)
	if err != nil {
		a.projects.fail(id, err)
		return
	}
	a.projects.Update(id, true, func(p *Project) { p.Source = info; p.Stage = "Preparing preview" })

	if err := a.makeProxy(ctx, id, src, info); err != nil {
		a.projects.fail(id, fmt.Errorf("couldn't prepare the preview: %w", err))
		return
	}
	posterAt := fmt.Sprintf("%.2f", math64Min(1, info.Duration/2))
	_ = ffmpegRun{Bin: a.cfg.FFmpeg, Dir: dir, Args: []string{
		"-ss", posterAt, "-i", "proxy.mp4", "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", "poster.jpg",
	}}.Run(ctx)

	a.projects.Update(id, true, func(p *Project) { p.Status, p.Stage, p.Progress = "ready", "", 1 })
}

func math64Min(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func (a *App) makeProxy(ctx context.Context, id, src string, info *SourceInfo) error {
	dir := a.projects.Dir(id)
	// Longest side 1280: plenty for tracking and preview, small enough to seek fast.
	scale := "scale='if(gte(iw,ih),min(1280,iw),-2)':'if(gte(iw,ih),-2,min(1280,ih))',format=yuv420p"
	audio := []string{"-an"}
	if info.HasAudio {
		audio = []string{"-map", "0:a:0", "-c:a", "aac", "-b:a", "128k", "-ac", "2"}
	}
	progress := func(f float64) { a.projects.Update(id, false, func(p *Project) { p.Progress = f }) }
	base := append(safeInput(src), "-map", "0:v:0", "-vf", scale)
	tail := append(append([]string{}, audio...), "-movflags", "+faststart", "proxy.mp4")

	// Hardware encoder first: it's several times faster on Apple silicon.
	hw := append(append(append([]string{}, base...), "-c:v", "h264_videotoolbox", "-b:v", "6M", "-g", "12"), tail...)
	err := ffmpegRun{Bin: a.cfg.FFmpeg, Dir: dir, Args: hw, Duration: info.Duration, OnProgress: progress}.Run(ctx)
	if err == nil {
		return nil
	}
	log.Printf("project %s: hardware proxy encode failed, using libx264: %v", id, err)
	sw := append(append(append([]string{}, base...), "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-g", "12"), tail...)
	return ffmpegRun{Bin: a.cfg.FFmpeg, Dir: dir, Args: sw, Duration: info.Duration, OnProgress: progress}.Run(ctx)
}

var ytPercent = regexp.MustCompile(`(\d+(?:\.\d+)?)%`)

// download fetches a link with yt-dlp (YouTube, Instagram, X, direct .mp4
// links, ...), picking the best video and audio available.
func (a *App) download(id, link string) {
	defer keepAwake()()
	ctx := context.Background()
	dir := a.projects.Dir(id)
	if a.cfg.YtDlp == "" {
		a.projects.fail(id, errors.New("yt-dlp isn't installed, so links can't be downloaded. Run: brew install yt-dlp"))
		return
	}
	a.projects.Update(id, true, func(p *Project) { p.Stage, p.Progress = "Downloading", 0 })

	args := []string{
		"--no-playlist", "--newline", "--no-colors", "--no-part",
		"-f", "bv*+ba/b", "--merge-output-format", "mkv",
		"--ffmpeg-location", filepath.Dir(a.cfg.FFmpeg),
		"--write-info-json", "-o", "source.%(ext)s",
		"--progress-template", "download:%(progress._percent_str)s",
		link,
	}
	cmd := exec.CommandContext(ctx, a.cfg.YtDlp, args...)
	cmd.Dir = dir
	var stderr tailBuffer
	cmd.Stderr = &stderr
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		a.projects.fail(id, err)
		return
	}
	part := 0
	last := 0.0
	sc := bufio.NewScanner(stdout)
	for sc.Scan() {
		m := ytPercent.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		v, _ := strconv.ParseFloat(m[1], 64)
		if v < last-50 { // second stream (audio) started
			part++
		}
		last = v
		stage := "Downloading"
		if part > 0 {
			stage = "Downloading audio"
		}
		a.projects.Update(id, false, func(p *Project) { p.Stage, p.Progress = stage, v/100 })
	}
	if err := cmd.Wait(); err != nil {
		a.projects.fail(id, fmt.Errorf("couldn't download that link: %s", stderr.String()))
		return
	}

	var file string
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		n := e.Name()
		if strings.HasPrefix(n, "source.") && !strings.HasSuffix(n, ".json") {
			file = n
		}
	}
	if file == "" {
		a.projects.fail(id, errors.New("the download finished but no video file was saved"))
		return
	}
	var meta struct {
		Title string `json:"title"`
	}
	_ = readJSONFile(filepath.Join(dir, "source.info.json"), &meta)
	a.projects.Update(id, true, func(p *Project) {
		p.SourceFile = file
		if meta.Title != "" {
			p.Name = meta.Title
		}
	})
	a.prepare(id)
}

func nameFromURL(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return "Video from link"
	}
	if base := filepath.Base(u.Path); base != "" && base != "/" && base != "." && filepath.Ext(base) != "" {
		return base
	}
	return u.Host
}
