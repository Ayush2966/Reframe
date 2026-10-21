package app

import (
	"context"
	"encoding/json"
	"net"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Phones reach Reframe through `tailscale serve`, which gives the Mac an
// HTTPS address (https://<mac>.<tailnet>.ts.net) that only the owner's devices
// can open. The app itself keeps listening on localhost only.

type PhoneStatus struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	DNSName   string `json:"dnsName,omitempty"`
	Serving   bool   `json:"serving"`
	URL       string `json:"url,omitempty"`
}

type tailscale struct {
	bin  string
	port string

	mu      sync.RWMutex
	status  PhoneStatus
	checked time.Time
}

func newTailscale(port string) *tailscale {
	t := &tailscale{bin: findTailscale(), port: port}
	t.refresh()
	go func() {
		for range time.Tick(20 * time.Second) {
			t.refresh()
		}
	}()
	return t
}

func findTailscale() string {
	if p := findTool("tailscale"); p != "" {
		return p
	}
	// The Mac app ships its CLI inside the bundle.
	const app = "/Applications/Tailscale.app/Contents/MacOS/Tailscale"
	if _, err := os.Stat(app); err == nil {
		return app
	}
	return ""
}

func (t *tailscale) Status() PhoneStatus {
	t.mu.RLock()
	stale := time.Since(t.checked) > 5*time.Second
	t.mu.RUnlock()
	if stale {
		t.refresh()
	}
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.status
}

// DNSName is the Mac's Tailscale name, or "" when Tailscale isn't up.
func (t *tailscale) DNSName() string {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.status.DNSName
}

func (t *tailscale) refresh() {
	st := PhoneStatus{Installed: t.bin != ""}
	if st.Installed {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		if out, err := exec.CommandContext(ctx, t.bin, "status", "--json").Output(); err == nil {
			st.Running, st.DNSName = parseTailscaleStatus(out)
		}
		if st.Running {
			if out, err := exec.CommandContext(ctx, t.bin, "serve", "status", "--json").Output(); err == nil {
				st.URL, st.Serving = parseServeStatus(out, t.port)
			}
		}
	}
	t.mu.Lock()
	t.status, t.checked = st, time.Now()
	t.mu.Unlock()
}

func parseTailscaleStatus(b []byte) (running bool, dnsName string) {
	var s struct {
		BackendState string
		Self         struct{ DNSName string }
	}
	if json.Unmarshal(b, &s) != nil {
		return false, ""
	}
	return s.BackendState == "Running", strings.TrimSuffix(s.Self.DNSName, ".")
}

// parseServeStatus finds a `tailscale serve` handler that forwards to this app.
func parseServeStatus(b []byte, port string) (publicURL string, ok bool) {
	var s struct {
		Web map[string]struct {
			Handlers map[string]struct{ Proxy string }
		}
	}
	if json.Unmarshal(b, &s) != nil {
		return "", false
	}
	for hostPort, web := range s.Web {
		for _, h := range web.Handlers {
			u, err := url.Parse(h.Proxy)
			if err != nil || !strings.Contains(h.Proxy, "://") {
				u, err = url.Parse("http://" + h.Proxy) // "127.0.0.1:8787" form
			}
			if err != nil || u.Port() != port || !isLoopback(u.Hostname()) {
				continue
			}
			host, p, _ := net.SplitHostPort(hostPort)
			if p == "" || p == "443" {
				return "https://" + host, true
			}
			return "https://" + hostPort, true
		}
	}
	return "", false
}

func isLoopback(host string) bool {
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
