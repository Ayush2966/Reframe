package app

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

type Job struct {
	ID          string     `json:"id"`
	ProjectID   string     `json:"projectId"`
	ProjectName string     `json:"projectName"`
	Output      OutputSpec `json:"output"`
	Size        string     `json:"size"`
	Enhance     string     `json:"enhance"`
	Quality     string     `json:"quality"`
	Width       int        `json:"width"`
	Height      int        `json:"height"`
	Duration    float64    `json:"duration"`

	Status     string     `json:"status"` // queued | running | done | failed | canceled
	Stage      string     `json:"stage,omitempty"`
	Progress   float64    `json:"progress"`
	ETASeconds float64    `json:"etaSeconds,omitempty"`
	Error      string     `json:"error,omitempty"`
	FileName   string     `json:"fileName,omitempty"`
	FileSize   int64      `json:"fileSize,omitempty"`
	CreatedAt  time.Time  `json:"createdAt"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	FinishedAt *time.Time `json:"finishedAt,omitempty"`
}

// JobManager renders one job at a time: x264 and the AI upscaler each use the
// whole machine, so running two at once only makes both slower.
type JobManager struct {
	dir   string
	app   *App
	mu    sync.Mutex
	jobs  map[string]*Job
	stops map[string]context.CancelFunc
	queue chan string
}

func newJobManager(dir string, a *App) (*JobManager, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	m := &JobManager{dir: dir, app: a, jobs: map[string]*Job{}, stops: map[string]context.CancelFunc{}, queue: make(chan string, 10000)}
	entries, _ := os.ReadDir(dir)
	var requeue []*Job
	for _, e := range entries {
		var j Job
		if !e.IsDir() || readJSONFile(filepath.Join(dir, e.Name(), "job.json"), &j) != nil {
			continue
		}
		switch j.Status {
		case "running":
			j.Status, j.Error, j.Stage = "failed", "Stopped because the app was closed. Render it again.", ""
			_ = m.save(&j)
		case "queued":
			requeue = append(requeue, &j)
		}
		m.jobs[j.ID] = &j
	}
	sort.Slice(requeue, func(i, k int) bool { return requeue[i].CreatedAt.Before(requeue[k].CreatedAt) })
	for _, j := range requeue {
		m.queue <- j.ID
	}
	go m.worker()
	return m, nil
}

func (m *JobManager) jobDir(id string) string { return filepath.Join(m.dir, id) }

func (m *JobManager) save(j *Job) error {
	return writeJSONFile(filepath.Join(m.jobDir(j.ID), "job.json"), j)
}

func (m *JobManager) Create(p Project, spec RenderSpec) ([]Job, error) {
	var out []Job
	for _, o := range spec.Outputs {
		one := spec
		one.Outputs = []OutputSpec{o}
		plan := planFor(p.Source, o, spec.Size, spec.Trim)
		j := &Job{
			ID: newID(), ProjectID: p.ID, ProjectName: p.Name, Output: o,
			Size: spec.Size, Enhance: spec.Enhance, Quality: spec.Quality,
			Width: plan.OutW, Height: plan.OutH, Duration: plan.Dur,
			Status: "queued", CreatedAt: time.Now(),
		}
		if err := os.MkdirAll(m.jobDir(j.ID), 0o755); err != nil {
			return nil, err
		}
		if err := writeJSONFile(filepath.Join(m.jobDir(j.ID), "spec.json"), one); err != nil {
			return nil, err
		}
		if err := m.save(j); err != nil {
			return nil, err
		}
		m.mu.Lock()
		m.jobs[j.ID] = j
		m.mu.Unlock()
		m.queue <- j.ID
		out = append(out, *j)
	}
	return out, nil
}

func (m *JobManager) Get(id string) (Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	if !ok {
		return Job{}, false
	}
	return *j, true
}

func (m *JobManager) List(projectID string) []Job {
	m.mu.Lock()
	out := []Job{}
	for _, j := range m.jobs {
		if projectID == "" || j.ProjectID == projectID {
			out = append(out, *j)
		}
	}
	m.mu.Unlock()
	sort.Slice(out, func(i, k int) bool { return out[i].CreatedAt.After(out[k].CreatedAt) })
	return out
}

func (m *JobManager) update(id string, persist bool, fn func(j *Job)) {
	m.mu.Lock()
	j, ok := m.jobs[id]
	if !ok {
		m.mu.Unlock()
		return
	}
	fn(j)
	cp := *j
	m.mu.Unlock()
	if persist {
		_ = m.save(&cp)
	}
}

func (m *JobManager) Cancel(id string) {
	m.mu.Lock()
	stop := m.stops[id]
	j, ok := m.jobs[id]
	queued := ok && j.Status == "queued"
	m.mu.Unlock()
	if stop != nil {
		stop()
	}
	if queued {
		now := time.Now()
		m.update(id, true, func(j *Job) { j.Status, j.Stage, j.FinishedAt = "canceled", "", &now })
	}
}

func (m *JobManager) Delete(id string) error {
	m.Cancel(id)
	m.mu.Lock()
	delete(m.jobs, id)
	m.mu.Unlock()
	return os.RemoveAll(m.jobDir(id))
}

// FilePath returns the finished file for a job, if there is one.
func (m *JobManager) FilePath(id string) (string, Job, bool) {
	j, ok := m.Get(id)
	if !ok || j.Status != "done" || j.FileName == "" {
		return "", j, false
	}
	return filepath.Join(m.jobDir(id), j.FileName), j, true
}

func (m *JobManager) worker() {
	for id := range m.queue {
		j, ok := m.Get(id)
		if !ok || j.Status != "queued" {
			continue
		}
		m.run(id)
	}
}

func (m *JobManager) run(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m.mu.Lock()
	m.stops[id] = cancel
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(m.stops, id)
		m.mu.Unlock()
	}()

	now := time.Now()
	m.update(id, true, func(j *Job) { j.Status, j.StartedAt, j.Stage = "running", &now, "Starting" })
	file, err := m.render(ctx, id)
	end := time.Now()

	switch {
	case errors.Is(err, context.Canceled) || ctx.Err() != nil:
		m.update(id, true, func(j *Job) { j.Status, j.Stage, j.FinishedAt = "canceled", "", &end })
	case err != nil:
		log.Printf("job %s failed: %v", id, err)
		m.update(id, true, func(j *Job) { j.Status, j.Stage, j.Error, j.FinishedAt = "failed", "", err.Error(), &end })
	default:
		st, _ := os.Stat(file)
		m.update(id, true, func(j *Job) {
			j.Status, j.Stage, j.Progress, j.ETASeconds, j.FinishedAt = "done", "", 1, 0, &end
			j.FileName = filepath.Base(file)
			if st != nil {
				j.FileSize = st.Size()
			}
		})
	}
	if j, ok := m.Get(id); ok {
		m.app.renderFinished(j)
	}
	// Keep only the finished file in the job folder.
	entries, _ := os.ReadDir(m.jobDir(id))
	for _, e := range entries {
		if n := e.Name(); n != "job.json" && n != "spec.json" && filepath.Join(m.jobDir(id), n) != file {
			_ = os.RemoveAll(filepath.Join(m.jobDir(id), n))
		}
	}
}

func (m *JobManager) render(ctx context.Context, id string) (string, error) {
	j, _ := m.Get(id)
	var spec RenderSpec
	if err := readJSONFile(filepath.Join(m.jobDir(id), "spec.json"), &spec); err != nil {
		return "", err
	}
	p, ok := m.app.projects.Get(j.ProjectID)
	if !ok || p.Source == nil {
		return "", errors.New("the source video for this render was deleted")
	}
	plan := planFor(p.Source, spec.Outputs[0], spec.Size, spec.Trim)
	r := &renderer{
		cfg: &m.app.cfg, src: filepath.Join(m.app.projects.Dir(p.ID), p.SourceFile),
		plan: plan, spec: spec, workDir: m.jobDir(id),
		progress: func(stage string, frac float64, eta time.Duration) {
			m.update(id, false, func(j *Job) { j.Stage, j.Progress, j.ETASeconds = stage, frac, eta.Seconds() })
		},
	}
	out, err := r.run(ctx)
	if err != nil {
		return "", err
	}
	// Give the file a readable name: "<video>-9x16-1080x1920.mp4".
	named := filepath.Join(m.jobDir(id), fmt.Sprintf("%s-%s-%dx%d%s",
		safeFileStem(p.Name), labelForFile(plan.Out), plan.OutW, plan.OutH, filepath.Ext(out)))
	if err := os.Rename(out, named); err != nil {
		return "", err
	}
	return named, nil
}
