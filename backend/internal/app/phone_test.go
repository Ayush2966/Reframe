package app

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func TestParseTailscaleStatus(t *testing.T) {
	running, name := parseTailscaleStatus([]byte(`{"BackendState":"Running","Self":{"DNSName":"my-mac.tail1234.ts.net."}}`))
	if !running || name != "my-mac.tail1234.ts.net" {
		t.Errorf("got %v %q", running, name)
	}
	if running, _ := parseTailscaleStatus([]byte(`{"BackendState":"Stopped"}`)); running {
		t.Error("stopped Tailscale reported as running")
	}
}

func TestParseServeStatus(t *testing.T) {
	cases := []struct {
		json, port, url string
		ok              bool
	}{
		{`{"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8787"}}}}}`, "8787", "https://my-mac.tail1234.ts.net", true},
		{`{"Web":{"my-mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://localhost:8787"}}}}}`, "8787", "https://my-mac.tail1234.ts.net:8443", true},
		{`{"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"127.0.0.1:8787"}}}}}`, "8787", "https://my-mac.tail1234.ts.net", true},
		{`{"Web":{"my-mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}`, "8787", "", false},
		{`{}`, "8787", "", false},
	}
	for _, c := range cases {
		url, ok := parseServeStatus([]byte(c.json), c.port)
		if url != c.url || ok != c.ok {
			t.Errorf("parseServeStatus(%s) = %q %v, want %q %v", c.json, url, ok, c.url, c.ok)
		}
	}
}

func TestHostGuard(t *testing.T) {
	allowed := func(h string) bool { return isLoopback(h) || h == "my-mac.tail1234.ts.net" }
	h := hostGuard(allowed, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	cases := []struct {
		host, origin string
		want         int
	}{
		{"localhost:8787", "", 200},
		{"127.0.0.1:8787", "http://localhost:5173", 200},
		{"my-mac.tail1234.ts.net", "https://my-mac.tail1234.ts.net", 200},
		{"evil.example", "", 403},                       // DNS rebinding
		{"localhost:8787", "https://evil.example", 403}, // another site in the browser
		{"my-mac.tail1234.ts.net", "https://other.ts.net", 403},
	}
	for _, c := range cases {
		r := httptest.NewRequest("POST", "/api/projects/link", nil)
		r.Host = c.host
		if c.origin != "" {
			r.Header.Set("Origin", c.origin)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != c.want {
			t.Errorf("host %s origin %q: got %d want %d", c.host, c.origin, w.Code, c.want)
		}
	}
}

// fakeDevice is a browser's side of a push subscription: its key pair and
// auth secret, so tests can decrypt what the server sends.
type fakeDevice struct {
	key  *ecdh.PrivateKey
	auth []byte
}

func fakeSubscription(t *testing.T, endpoint string) (webpush.Subscription, fakeDevice) {
	t.Helper()
	key, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return webpush.Subscription{Endpoint: endpoint, Keys: webpush.Keys{
		P256dh: base64.RawURLEncoding.EncodeToString(key.PublicKey().Bytes()),
		Auth:   base64.RawURLEncoding.EncodeToString(auth),
	}}, fakeDevice{key, auth}
}

func hmacSHA256(key []byte, parts ...[]byte) []byte {
	m := hmac.New(sha256.New, key)
	for _, p := range parts {
		m.Write(p)
	}
	return m.Sum(nil)
}

// decrypt undoes RFC 8291 (aes128gcm) the way a browser does.
func (d fakeDevice) decrypt(t *testing.T, body []byte) []byte {
	t.Helper()
	salt, rs, idLen := body[:16], binary.BigEndian.Uint32(body[16:20]), int(body[20])
	serverPub, ct := body[21:21+idLen], body[21+idLen:]
	if rs < 18 || len(ct) > int(rs) {
		t.Fatalf("unexpected record size %d for %d bytes", rs, len(ct))
	}
	peer, err := ecdh.P256().NewPublicKey(serverPub)
	if err != nil {
		t.Fatalf("server key: %v", err)
	}
	shared, err := d.key.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	prkKey := hmacSHA256(d.auth, shared)
	info := append(append([]byte("WebPush: info\x00"), d.key.PublicKey().Bytes()...), serverPub...)
	ikm := hmacSHA256(prkKey, info, []byte{1})[:32]
	prk := hmacSHA256(salt, ikm)
	cek := hmacSHA256(prk, []byte("Content-Encoding: aes128gcm\x00"), []byte{1})[:16]
	nonce := hmacSHA256(prk, []byte("Content-Encoding: nonce\x00"), []byte{1})[:12]
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		t.Fatalf("a browser couldn't decrypt this push: %v", err)
	}
	plain = bytes.TrimRight(plain, "\x00") // padding
	if len(plain) == 0 || plain[len(plain)-1] != 2 {
		t.Fatal("missing last-record delimiter")
	}
	return plain[:len(plain)-1]
}

func TestPushDeliversAndForgetsGoneDevices(t *testing.T) {
	var status atomic.Int32
	status.Store(http.StatusCreated)
	var got atomic.Pointer[http.Request]
	var gotBody atomic.Pointer[[]byte]
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got.Store(r)
		gotBody.Store(&b)
		w.WriteHeader(int(status.Load()))
	}))
	defer srv.Close()

	p, err := newPushStore(t.TempDir(), "reframe@example.com")
	if err != nil {
		t.Fatal(err)
	}
	p.client = srv.Client()
	if err := p.Subscribe(webpush.Subscription{Endpoint: "http://insecure.example/x"}); err == nil {
		t.Error("accepted a non-https endpoint")
	}
	sub, device := fakeSubscription(t, srv.URL+"/push/abc")
	if err := p.Subscribe(sub); err != nil {
		t.Fatal(err)
	}

	want := pushMessage{Title: "9:16 video ready", Body: "tears-of-steel, 1080x1920", URL: "/#/v/0123456789abcdef", Tag: "renders-0123456789abcdef"}
	if n := p.Notify(want); n != 1 {
		t.Fatalf("sent %d, want 1", n)
	}
	var gotMsg pushMessage
	if err := json.Unmarshal(device.decrypt(t, *gotBody.Load()), &gotMsg); err != nil || gotMsg != want {
		t.Errorf("the phone would read %+v (%v), want %+v", gotMsg, err, want)
	}
	r := got.Load()
	if r.Header.Get("Content-Encoding") != "aes128gcm" || r.Header.Get("TTL") == "" {
		t.Errorf("not an encrypted web push: %v", r.Header)
	}
	if auth := r.Header.Get("Authorization"); len(auth) < 10 || auth[:6] != "vapid " {
		t.Errorf("missing VAPID authorization: %q", auth)
	}

	status.Store(http.StatusGone)
	p.Notify(pushMessage{Title: "again"})
	if p.Count() != 0 {
		t.Error("a device the push service says is gone should be forgotten")
	}
}
