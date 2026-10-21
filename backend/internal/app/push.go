package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	webpush "github.com/SherClockHolmes/webpush-go"
)

// Push notifications tell a phone that a render finished, even when the app
// is closed: long AI renders take minutes and nobody watches a progress bar.
// Keys (VAPID) are generated once and kept in data/push.

type pushStore struct {
	dir     string
	contact string
	client  webpush.HTTPClient // nil means the default client; tests swap it

	mu   sync.Mutex
	keys struct {
		Public  string `json:"public"`
		Private string `json:"private"`
	}
	subs []webpush.Subscription
}

type pushMessage struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url"`
	Tag   string `json:"tag"`
}

func newPushStore(dir, contact string) (*pushStore, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	p := &pushStore{dir: dir, contact: contact}
	keyFile := filepath.Join(dir, "vapid.json")
	if readJSONFile(keyFile, &p.keys) != nil || p.keys.Public == "" {
		priv, pub, err := webpush.GenerateVAPIDKeys()
		if err != nil {
			return nil, err
		}
		p.keys.Public, p.keys.Private = pub, priv
		if err := writeJSONFile(keyFile, p.keys); err != nil {
			return nil, err
		}
		_ = os.Chmod(keyFile, 0o600)
	}
	_ = readJSONFile(filepath.Join(dir, "subscriptions.json"), &p.subs)
	return p, nil
}

func (p *pushStore) PublicKey() string { return p.keys.Public }

func (p *pushStore) saveLocked() error {
	return writeJSONFile(filepath.Join(p.dir, "subscriptions.json"), p.subs)
}

func (p *pushStore) Subscribe(s webpush.Subscription) error {
	u, err := url.Parse(s.Endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || s.Keys.Auth == "" || s.Keys.P256dh == "" {
		return errors.New("that isn't a valid push subscription")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for i, old := range p.subs {
		if old.Endpoint == s.Endpoint {
			p.subs[i] = s
			return p.saveLocked()
		}
	}
	p.subs = append(p.subs, s)
	return p.saveLocked()
}

func (p *pushStore) Unsubscribe(endpoint string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	keep := p.subs[:0]
	for _, s := range p.subs {
		if s.Endpoint != endpoint {
			keep = append(keep, s)
		}
	}
	p.subs = keep
	return p.saveLocked()
}

func (p *pushStore) Count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.subs)
}

// Notify sends to every subscribed device and forgets the ones the push
// service says are gone. It returns how many deliveries were accepted.
func (p *pushStore) Notify(msg pushMessage) int {
	p.mu.Lock()
	subs := append([]webpush.Subscription(nil), p.subs...)
	p.mu.Unlock()
	if len(subs) == 0 {
		return 0
	}
	body, _ := json.Marshal(msg)
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		gone []string
		sent int
	)
	for _, s := range subs {
		wg.Add(1)
		go func(s webpush.Subscription) {
			defer wg.Done()
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			resp, err := webpush.SendNotificationWithContext(ctx, body, &s, &webpush.Options{
				Subscriber:      p.contact,
				VAPIDPublicKey:  p.keys.Public,
				VAPIDPrivateKey: p.keys.Private,
				TTL:             60 * 60 * 6,
				Urgency:         webpush.UrgencyHigh,
				Topic:           topicFor(msg.Tag),
				HTTPClient:      p.client,
			})
			if err != nil {
				log.Printf("push: %v", err)
				return
			}
			resp.Body.Close()
			mu.Lock()
			defer mu.Unlock()
			switch {
			case resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusGone:
				gone = append(gone, s.Endpoint)
			case resp.StatusCode >= 300:
				log.Printf("push: %s answered %s", hostOf(s.Endpoint), resp.Status)
			default:
				sent++
			}
		}(s)
	}
	wg.Wait()
	for _, e := range gone {
		_ = p.Unsubscribe(e)
	}
	return sent
}

// topicFor lets the push service replace an undelivered older message with
// the same tag (Topic must be ≤32 URL-safe characters).
func topicFor(tag string) string {
	if len(tag) > 32 {
		tag = tag[:32]
	}
	return tag
}

func hostOf(endpoint string) string {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "push service"
	}
	return u.Host
}

// renderFinished builds the notification for a finished job.
func (a *App) renderFinished(j Job) {
	if a.push == nil || a.push.Count() == 0 {
		return
	}
	left := 0
	for _, o := range a.jobs.List(j.ProjectID) {
		if o.Status == "queued" || o.Status == "running" {
			left++
		}
	}
	shape := fmt.Sprintf("%d:%d", j.Output.RW, j.Output.RH)
	msg := pushMessage{URL: "/#/v/" + j.ProjectID, Tag: "renders-" + j.ProjectID}
	switch j.Status {
	case "done":
		msg.Title = fmt.Sprintf("%s video ready", shape)
		msg.Body = fmt.Sprintf("%s, %dx%d", j.ProjectName, j.Width, j.Height)
	case "failed":
		msg.Title = fmt.Sprintf("%s render failed", shape)
		msg.Body = j.Error
	default:
		return
	}
	if left > 0 {
		msg.Body += fmt.Sprintf(". %d still rendering.", left)
	}
	go a.push.Notify(msg)
}
