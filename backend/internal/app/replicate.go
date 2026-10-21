package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// replicateClient talks to Replicate's HTTP API. Cloud enhance uses Topaz
// Labs' video upscaler, which bills the Replicate account per video second.
type replicateClient struct {
	token string
	http  http.Client
}

const replicateAPI = "https://api.replicate.com/v1"
const cloudModel = "topazlabs/video-upscale"

type replicatePrediction struct {
	ID     string          `json:"id"`
	Status string          `json:"status"`
	Output json.RawMessage `json:"output"`
	Error  any             `json:"error"`
	URLs   struct {
		Get    string `json:"get"`
		Cancel string `json:"cancel"`
	} `json:"urls"`
}

func (c *replicateClient) do(ctx context.Context, method, url string, body io.Reader, contentType string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 300 {
		var e struct {
			Detail string `json:"detail"`
			Title  string `json:"title"`
		}
		_ = json.Unmarshal(b, &e)
		msg := e.Detail
		if msg == "" {
			msg = resp.Status
		}
		if resp.StatusCode == http.StatusUnauthorized {
			msg = "Replicate rejected the API token in .env"
		}
		return fmt.Errorf("replicate: %s", msg)
	}
	if out != nil {
		return json.Unmarshal(b, out)
	}
	return nil
}

func (c *replicateClient) upload(ctx context.Context, path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	pr, pw := io.Pipe()
	mw := multipart.NewWriter(pw)
	go func() {
		part, err := mw.CreateFormFile("content", filepath.Base(path))
		if err == nil {
			_, err = io.Copy(part, f)
		}
		if err == nil {
			err = mw.Close()
		}
		pw.CloseWithError(err)
	}()
	var res struct {
		URLs struct {
			Get string `json:"get"`
		} `json:"urls"`
	}
	if err := c.do(ctx, http.MethodPost, replicateAPI+"/files", pr, mw.FormDataContentType(), &res); err != nil {
		return "", err
	}
	if res.URLs.Get == "" {
		return "", errors.New("replicate: upload returned no file URL")
	}
	return res.URLs.Get, nil
}

func (c *replicateClient) upscaleVideo(ctx context.Context, in, out, target string, fps int, stage func(string)) error {
	stage("Uploading to the cloud")
	fileURL, err := c.upload(ctx, in)
	if err != nil {
		return err
	}
	if fps < 15 {
		fps = 15
	}
	if fps > 60 {
		fps = 60
	}
	body, _ := json.Marshal(map[string]any{"input": map[string]any{
		"video": fileURL, "target_resolution": target, "target_fps": fps,
	}})
	var pred replicatePrediction
	if err := c.do(ctx, http.MethodPost, replicateAPI+"/models/"+cloudModel+"/predictions", bytes.NewReader(body), "application/json", &pred); err != nil {
		return err
	}
	stage("Upscaling in the cloud")
	for pred.Status != "succeeded" {
		switch pred.Status {
		case "failed", "canceled", "aborted":
			return fmt.Errorf("cloud upscale %s: %v", pred.Status, pred.Error)
		}
		select {
		case <-ctx.Done():
			cancelCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_ = c.do(cancelCtx, http.MethodPost, pred.URLs.Cancel, nil, "", nil)
			cancel()
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
		if err := c.do(ctx, http.MethodGet, pred.URLs.Get, nil, "", &pred); err != nil {
			return err
		}
	}

	var outURL string
	if err := json.Unmarshal(pred.Output, &outURL); err != nil {
		var list []string
		if json.Unmarshal(pred.Output, &list) != nil || len(list) == 0 {
			return errors.New("cloud upscale finished without a video")
		}
		outURL = list[len(list)-1]
	}
	stage("Downloading the upscaled video")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, outURL, nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading the upscaled video: %s", resp.Status)
	}
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
