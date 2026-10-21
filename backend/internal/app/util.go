package app

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

func newID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func validID(id string) bool {
	if len(id) != 16 {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

// writeJSON writes atomically so a crash mid-write never leaves a half file.
func writeJSONFile(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func readJSONFile(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

// safeFileStem turns a title into something usable in a download file name.
func safeFileStem(name string) string {
	stem := strings.TrimSuffix(filepath.Base(name), filepath.Ext(name))
	stem = unsafeName.ReplaceAllString(stem, "")
	stem = strings.Join(strings.Fields(stem), "-")
	if len(stem) > 60 {
		stem = stem[:60]
	}
	if stem == "" {
		stem = "video"
	}
	return stem
}

var videoExts = map[string]bool{
	".mp4": true, ".mov": true, ".m4v": true, ".mkv": true, ".webm": true,
	".avi": true, ".mts": true, ".m2ts": true, ".ts": true, ".mxf": true,
	".wmv": true, ".flv": true, ".3gp": true, ".mpg": true, ".mpeg": true,
}

func sourceExt(name string) string {
	ext := strings.ToLower(filepath.Ext(name))
	if videoExts[ext] {
		return ext
	}
	return ".mp4"
}

func clamp(v, lo, hi float64) float64 {
	return math.Max(lo, math.Min(hi, v))
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
