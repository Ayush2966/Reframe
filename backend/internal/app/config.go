package app

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Config holds everything the server needs to know about the machine it runs on.
type Config struct {
	DataDir        string
	ToolsDir       string
	StaticDir      string
	ReplicateToken string
	Port           string
	ExtraHosts     []string // extra Host names to accept, besides localhost and Tailscale
	PushContact    string   // VAPID "sub": an email (mailto: is added) or an https: URL

	FFmpeg  string
	FFprobe string
	YtDlp   string
}

// ResolveTools fills in absolute paths for the external programs. Homebrew's
// bin dir is checked explicitly because apps started outside a login shell
// often don't have it on PATH.
func (c *Config) ResolveTools() {
	c.FFmpeg = findTool("ffmpeg")
	c.FFprobe = findTool("ffprobe")
	c.YtDlp = findTool("yt-dlp")
}

func findTool(name string) string {
	if p, err := exec.LookPath(name); err == nil {
		return p
	}
	for _, dir := range []string{"/opt/homebrew/bin", "/usr/local/bin"} {
		p := filepath.Join(dir, name)
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

// RealESRGAN returns the upscaler binary and its models dir. The binary refuses
// a models path that doesn't contain the word "models", so keep that name.
func (c *Config) RealESRGAN() (bin, models string) {
	dir := filepath.Join(c.ToolsDir, "realesrgan")
	return filepath.Join(dir, "realesrgan-ncnn-vulkan"), filepath.Join(dir, "models")
}

// AIModel is Real-ESRGAN's compact general-purpose model (realesr-general-x4v3),
// as converted to ncnn by Upscayl. It is ~17x faster than realesrgan-x4plus on
// Apple GPUs and works on real footage, unlike the anime video model.
const AIModel = "upscayl-lite-4x"

func (c *Config) AILocalAvailable() bool {
	bin, models := c.RealESRGAN()
	if _, err := os.Stat(bin); err != nil {
		return false
	}
	_, err := os.Stat(filepath.Join(models, AIModel+".bin"))
	return err == nil
}

// LoadDotEnv sets variables from a KEY=value file without overriding ones
// already present in the environment. A missing file is not an error.
func LoadDotEnv(path string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(strings.TrimPrefix(k, "export "))
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		if _, set := os.LookupEnv(k); !set {
			os.Setenv(k, v)
		}
	}
}
