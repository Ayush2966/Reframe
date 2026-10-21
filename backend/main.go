// Command reframe serves the Reframe app: a local tool that reshapes videos
// (wide to tall and back), follows the subject, grades and upscales them.
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"reframe/internal/app"
)

func main() {
	root := flag.String("root", "..", "project root that holds data/, tools/ and frontend/dist")
	port := flag.String("port", envOr("PORT", "8787"), "port to listen on (localhost only)")
	flag.Parse()

	abs, err := filepath.Abs(*root)
	if err != nil {
		log.Fatal(err)
	}
	app.LoadDotEnv(filepath.Join(abs, ".env"))
	var hosts []string
	for _, h := range strings.Split(os.Getenv("REFRAME_HOSTS"), ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	a, err := app.New(app.Config{
		DataDir:        filepath.Join(abs, "data"),
		ToolsDir:       filepath.Join(abs, "tools"),
		StaticDir:      filepath.Join(abs, "frontend", "dist"),
		ReplicateToken: os.Getenv("REPLICATE_API_TOKEN"),
		Port:           *port,
		ExtraHosts:     hosts,
		PushContact:    envOr("PUSH_CONTACT", "reframe@example.com"), // the push library adds "mailto:"
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("Reframe is running at http://localhost:%s", *port)
	log.Fatal(http.ListenAndServe("127.0.0.1:"+*port, a.Handler()))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
