package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type App struct {
	cfg      Config
	projects *ProjectStore
	jobs     *JobManager
	ts       *tailscale
	push     *pushStore
}

func New(cfg Config) (*App, error) {
	cfg.ResolveTools()
	if cfg.FFmpeg == "" || cfg.FFprobe == "" {
		return nil, errors.New("ffmpeg isn't installed. Run: brew install ffmpeg")
	}
	a := &App{cfg: cfg}
	var err error
	if a.projects, err = newProjectStore(filepath.Join(cfg.DataDir, "projects")); err != nil {
		return nil, err
	}
	if a.push, err = newPushStore(filepath.Join(cfg.DataDir, "push"), cfg.PushContact); err != nil {
		return nil, err
	}
	if a.jobs, err = newJobManager(filepath.Join(cfg.DataDir, "renders"), a); err != nil {
		return nil, err
	}
	a.ts = newTailscale(cfg.Port)
	return a, nil
}

func (a *App) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", a.health)

	mux.HandleFunc("GET /api/projects", a.listProjects)
	mux.HandleFunc("POST /api/projects/upload", a.uploadProject)
	mux.HandleFunc("POST /api/projects/link", a.linkProject)
	mux.HandleFunc("GET /api/projects/{id}", a.withProject(a.getProject))
	mux.HandleFunc("DELETE /api/projects/{id}", a.withProject(a.deleteProject))
	mux.HandleFunc("GET /api/projects/{id}/proxy.mp4", a.withProject(a.serveProjectFile("proxy.mp4")))
	mux.HandleFunc("GET /api/projects/{id}/poster.jpg", a.withProject(a.serveProjectFile("poster.jpg")))
	mux.HandleFunc("GET /api/projects/{id}/analysis", a.withProject(a.serveProjectFile("analysis.json")))
	mux.HandleFunc("PUT /api/projects/{id}/analysis", a.withProject(a.putProjectJSON("analysis.json")))
	mux.HandleFunc("GET /api/projects/{id}/state", a.withProject(a.serveProjectFile("state.json")))
	mux.HandleFunc("PUT /api/projects/{id}/state", a.withProject(a.putProjectJSON("state.json")))
	mux.HandleFunc("POST /api/projects/{id}/frame", a.withProject(a.previewFrame))

	mux.HandleFunc("POST /api/exports", a.createExport)
	mux.HandleFunc("GET /api/jobs", a.listJobs)
	mux.HandleFunc("GET /api/jobs/{id}", a.getJob)
	mux.HandleFunc("POST /api/jobs/{id}/cancel", a.cancelJob)
	mux.HandleFunc("DELETE /api/jobs/{id}", a.deleteJob)
	mux.HandleFunc("GET /api/jobs/{id}/file", a.downloadJob)
	mux.HandleFunc("POST /api/jobs/{id}/reveal", a.revealJob)

	mux.HandleFunc("GET /api/phone", a.phoneStatus)
	mux.HandleFunc("GET /api/push", a.pushInfo)
	mux.HandleFunc("POST /api/push/subscribe", a.pushSubscribe)
	mux.HandleFunc("POST /api/push/unsubscribe", a.pushUnsubscribe)
	mux.HandleFunc("POST /api/push/test", a.pushTest)

	mux.Handle("/", a.static())
	return hostGuard(a.allowedHost, logRequests(mux))
}

// allowedHost: localhost, the Mac's Tailscale name (what `tailscale serve`
// forwards), and anything listed in REFRAME_HOSTS.
func (a *App) allowedHost(host string) bool {
	if isLoopback(host) {
		return true
	}
	if ts := a.ts.DNSName(); ts != "" && strings.EqualFold(host, ts) {
		return true
	}
	for _, h := range a.cfg.ExtraHosts {
		if strings.EqualFold(host, h) {
			return true
		}
	}
	return false
}

// hostGuard rejects requests from other websites open in the browser (they
// could otherwise make this app download links or open Finder) and from
// DNS-rebinding hosts: both the Host and any Origin must be allowed.
func hostGuard(allowed func(string) bool, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		host := r.Host
		if hh, _, err := net.SplitHostPort(host); err == nil {
			host = hh
		}
		if !allowed(strings.Trim(host, "[]")) {
			http.Error(w, "Reframe only answers on this Mac and its Tailscale address.", http.StatusForbidden)
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !allowed(u.Hostname()) {
				http.Error(w, "Requests from other sites aren't allowed.", http.StatusForbidden)
				return
			}
		}
		h.ServeHTTP(w, r)
	})
}

func logRequests(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		h.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Method != http.MethodGet {
			log.Printf("%s %s (%s)", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// --- helpers ---------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (a *App) withProject(fn func(http.ResponseWriter, *http.Request, Project)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		p, ok := a.projects.Get(id)
		if !validID(id) || !ok {
			writeError(w, http.StatusNotFound, "That video isn't here any more.")
			return
		}
		fn(w, r, p)
	}
}

// --- handlers --------------------------------------------------------------

func (a *App) health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ffmpeg":  a.cfg.FFmpeg != "",
		"ytdlp":   a.cfg.YtDlp != "",
		"aiLocal": a.cfg.AILocalAvailable(),
		"aiCloud": a.cfg.ReplicateToken != "",
		// Measured on an M2 Pro with the lite model: ~0.6 s for a 608x1080 frame.
		"aiSecondsPerMegapixel": 0.95,
	})
}

func (a *App) listProjects(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.projects.List())
}

func (a *App) getProject(w http.ResponseWriter, _ *http.Request, p Project) {
	writeJSON(w, http.StatusOK, p)
}

func (a *App) uploadProject(w http.ResponseWriter, r *http.Request) {
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		name = "video.mp4"
	}
	p, err := a.projects.Create(filepath.Base(name), "")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	file := "source" + sourceExt(name)
	a.projects.Update(p.ID, true, func(p *Project) { p.SourceFile, p.Stage = file, "Uploading" })
	f, err := os.Create(filepath.Join(a.projects.Dir(p.ID), file))
	if err == nil {
		_, err = io.Copy(f, r.Body)
		if cerr := f.Close(); err == nil {
			err = cerr
		}
	}
	if err != nil {
		_ = a.projects.Delete(p.ID)
		writeError(w, http.StatusBadRequest, "The upload didn't finish: "+err.Error())
		return
	}
	go a.prepare(p.ID)
	cp, _ := a.projects.Get(p.ID)
	writeJSON(w, http.StatusCreated, cp)
}

func (a *App) linkProject(w http.ResponseWriter, r *http.Request) {
	var body struct {
		URL string `json:"url"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "Send a link to import.")
		return
	}
	u, err := url.Parse(strings.TrimSpace(body.URL))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeError(w, http.StatusBadRequest, "That doesn't look like a web link. Paste a full address starting with https://")
		return
	}
	p, err := a.projects.Create(nameFromURL(u.String()), u.String())
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	go a.download(p.ID, u.String())
	writeJSON(w, http.StatusCreated, p)
}

func (a *App) deleteProject(w http.ResponseWriter, _ *http.Request, p Project) {
	if p.Status == "importing" {
		writeError(w, http.StatusConflict, "Wait for the import to finish before deleting this video.")
		return
	}
	if err := a.projects.Delete(p.ID); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) serveProjectFile(name string) func(http.ResponseWriter, *http.Request, Project) {
	return func(w http.ResponseWriter, r *http.Request, p Project) {
		path := filepath.Join(a.projects.Dir(p.ID), name)
		isJSON := strings.HasSuffix(name, ".json")
		if isJSON {
			w.Header().Set("Cache-Control", "no-store")
		}
		if _, err := os.Stat(path); err != nil {
			if isJSON { // nothing saved yet
				writeJSON(w, http.StatusOK, nil)
				return
			}
			writeError(w, http.StatusNotFound, "Not ready yet.")
			return
		}
		if isJSON {
			w.Header().Set("Content-Type", "application/json")
		}
		http.ServeFile(w, r, path)
	}
}

// putProjectJSON stores editor data (tracking results, edits) next to the
// project so reopening a video picks up where it was left.
func (a *App) putProjectJSON(name string) func(http.ResponseWriter, *http.Request, Project) {
	return func(w http.ResponseWriter, r *http.Request, p Project) {
		b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
		if err != nil || !json.Valid(b) {
			writeError(w, http.StatusBadRequest, "Expected JSON.")
			return
		}
		path := filepath.Join(a.projects.Dir(p.ID), name)
		err = os.WriteFile(path+".tmp", b, 0o644)
		if err == nil {
			err = os.Rename(path+".tmp", path)
		}
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *App) decodeSpec(w http.ResponseWriter, r *http.Request, into any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<20)).Decode(into); err != nil {
		writeError(w, http.StatusBadRequest, "Couldn't read the export settings: "+err.Error())
		return false
	}
	return true
}

func (a *App) previewFrame(w http.ResponseWriter, r *http.Request, p Project) {
	var body struct {
		Spec RenderSpec `json:"spec"`
		Time float64    `json:"time"`
	}
	if !a.decodeSpec(w, r, &body) {
		return
	}
	if p.Status != "ready" {
		writeError(w, http.StatusConflict, "The video is still importing.")
		return
	}
	if err := body.Spec.validate(p.Source); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	plan := planFor(p.Source, body.Spec.Outputs[0], body.Spec.Size, nil)
	t := clamp(body.Time, 0, p.Source.Duration-0.05)
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	tmp, err := os.MkdirTemp("", "reframe-frame-")
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer os.RemoveAll(tmp)
	png, err := renderFrame(ctx, &a.cfg, filepath.Join(a.projects.Dir(p.ID), p.SourceFile), plan, body.Spec, t, tmp)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("X-Frame-Size", fmt.Sprintf("%dx%d", plan.OutW, plan.OutH))
	_, _ = w.Write(png)
}

func (a *App) createExport(w http.ResponseWriter, r *http.Request) {
	var spec RenderSpec
	if !a.decodeSpec(w, r, &spec) {
		return
	}
	p, ok := a.projects.Get(spec.ProjectID)
	if !ok || p.Status != "ready" || p.Source == nil {
		writeError(w, http.StatusBadRequest, "That video isn't ready to export.")
		return
	}
	if err := spec.validate(p.Source); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if spec.Enhance == "ai" && !a.cfg.AILocalAvailable() {
		writeError(w, http.StatusBadRequest, "The AI upscaler isn't installed. Run ./scripts/setup.sh and restart.")
		return
	}
	if spec.Enhance == "cloud" && a.cfg.ReplicateToken == "" {
		writeError(w, http.StatusBadRequest, "Cloud enhance needs REPLICATE_API_TOKEN in .env. Add it and restart.")
		return
	}
	jobs, err := a.jobs.Create(p, spec)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusCreated, jobs)
}

func (a *App) listJobs(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.jobs.List(r.URL.Query().Get("projectId")))
}

func (a *App) jobOr404(w http.ResponseWriter, r *http.Request) (Job, bool) {
	id := r.PathValue("id")
	j, ok := a.jobs.Get(id)
	if !validID(id) || !ok {
		writeError(w, http.StatusNotFound, "That render isn't here any more.")
		return Job{}, false
	}
	return j, true
}

func (a *App) getJob(w http.ResponseWriter, r *http.Request) {
	if j, ok := a.jobOr404(w, r); ok {
		writeJSON(w, http.StatusOK, j)
	}
}

func (a *App) cancelJob(w http.ResponseWriter, r *http.Request) {
	if j, ok := a.jobOr404(w, r); ok {
		a.jobs.Cancel(j.ID)
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *App) deleteJob(w http.ResponseWriter, r *http.Request) {
	if j, ok := a.jobOr404(w, r); ok {
		if err := a.jobs.Delete(j.ID); err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

func (a *App) downloadJob(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.jobOr404(w, r); !ok {
		return
	}
	path, j, ok := a.jobs.FilePath(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusConflict, "This render hasn't finished.")
		return
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", j.FileName))
	http.ServeFile(w, r, path)
}

// revealJob shows the finished file in Finder. The app only listens on
// localhost, so this only ever opens a window on this Mac.
func (a *App) revealJob(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.jobOr404(w, r); !ok {
		return
	}
	path, _, ok := a.jobs.FilePath(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusConflict, "This render hasn't finished.")
		return
	}
	if err := exec.Command("open", "-R", path).Run(); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) phoneStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, a.ts.Status())
}

func (a *App) pushInfo(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"publicKey": a.push.PublicKey(), "devices": a.push.Count()})
}

func (a *App) pushSubscribe(w http.ResponseWriter, r *http.Request) {
	var sub webpush.Subscription
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&sub); err != nil {
		writeError(w, http.StatusBadRequest, "Expected a push subscription.")
		return
	}
	if err := a.push.Subscribe(sub); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) pushUnsubscribe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Endpoint string `json:"endpoint"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&body); err != nil || body.Endpoint == "" {
		writeError(w, http.StatusBadRequest, "Expected an endpoint.")
		return
	}
	if err := a.push.Unsubscribe(body.Endpoint); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) pushTest(w http.ResponseWriter, _ *http.Request) {
	n := a.push.Notify(pushMessage{Title: "Notifications are on", Body: "You'll hear from Reframe when a render finishes.", URL: "/", Tag: "test"})
	writeJSON(w, http.StatusOK, map[string]int{"sent": n})
}

// static serves the built frontend, falling back to index.html for app routes.
// The page and the service worker are never cached by the browser (so updates
// land); Vite's hashed /assets are cached forever.
func (a *App) static() http.Handler {
	fs := http.FileServer(http.Dir(a.cfg.StaticDir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeError(w, http.StatusNotFound, "Unknown API route.")
			return
		}
		if r.URL.Path == "/share-target" {
			// Normally the service worker answers this; without it, start over.
			http.Redirect(w, r, "/?share=none", http.StatusSeeOther)
			return
		}
		index := filepath.Join(a.cfg.StaticDir, "index.html")
		if _, err := os.Stat(index); err != nil {
			http.Error(w, "The app isn't built yet. Run: make build (or use make dev).", http.StatusNotFound)
			return
		}
		clean := filepath.Clean("/" + r.URL.Path)
		switch {
		case clean == "/sw.js":
			w.Header().Set("Cache-Control", "no-cache")
		case strings.HasPrefix(clean, "/assets/"):
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		case strings.HasSuffix(clean, ".webmanifest"):
			w.Header().Set("Content-Type", "application/manifest+json")
			w.Header().Set("Cache-Control", "no-cache")
		}
		if st, err := os.Stat(filepath.Join(a.cfg.StaticDir, clean)); err != nil || st.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, index)
			return
		}
		fs.ServeHTTP(w, r)
	})
}
