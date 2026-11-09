package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/coder/websocket"
)

func TestRoutingAndUnlink(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	const a, b, connector = "a.beta.example", "b.beta.example", "connector.beta.example"
	grants := map[string]string{hashToken("first"): a, hashToken("second"): b}
	var mu sync.Mutex
	g := newGateway(connector, func(_ context.Context, hashes []string) (map[string]string, error) {
		mu.Lock()
		defer mu.Unlock()
		valid := make(map[string]string)
		for _, key := range hashes {
			if route, ok := grants[key]; ok {
				valid[key] = route
			}
		}
		return valid, nil
	})
	defer g.close()
	go g.runAdmissions(ctx)
	edge := httptest.NewTLSServer(g)
	defer edge.Close()
	// Use the certificate's real loopback IP for TLS while presenting the staging ingress names.
	client := edge.Client()
	base := strings.TrimPrefix(edge.URL, "https://")
	hostClient := &http.Client{Transport: hostHeaderTransport{base: client.Transport, host: connector}, CheckRedirect: rejectRedirect}
	var writes atomic.Int32
	newOrigin := func(name string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/ws":
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				for {
					typ, data, err := conn.Read(r.Context())
					if err != nil {
						return
					}
					if err = conn.Write(r.Context(), typ, data); err != nil {
						return
					}
				}
			case "/ambiguous":
				writes.Add(1)
				conn, _, _ := w.(http.Hijacker).Hijack()
				_ = conn.Close()
			case "/404":
				w.WriteHeader(404)
				_, _ = io.WriteString(w, "origin 404")
			default:
				_, _ = fmt.Fprintf(w, "%s|%s|%s|%s|%s", name, r.Host, r.Header.Get("X-Forwarded-Proto"), r.Header.Get("X-Forwarded-Host"), r.Header.Get("Forwarded"))
			}
		}))
	}
	oa, ob := newOrigin("alpha"), newOrigin("beta")
	defer oa.Close()
	defer ob.Close()
	attach := func(token string, origin *httptest.Server) context.CancelFunc {
		t.Helper()
		life, stop := context.WithCancel(ctx)
		ready, done := make(chan struct{}), make(chan error, 1)
		go func() {
			done <- connectHost(life, "wss://"+base+"/connect", token, origin.Listener.Addr().String(), hostClient, func() { close(ready) })
		}()
		select {
		case <-ready:
		case err := <-done:
			stop()
			t.Fatalf("connect: %v", err)
		}
		return stop
	}
	stopA := attach("first", oa)
	defer stopA()
	stopB := attach("second", ob)
	defer stopB()
	call := func(name, path, method string) (int, string) {
		t.Helper()
		req, _ := http.NewRequestWithContext(ctx, method, edge.URL+path, nil)
		req.Host = name
		req.Header.Set("X-Forwarded-Proto", "http")
		req.Header.Set("X-Forwarded-Host", "attacker.invalid")
		req.Header.Set("Forwarded", "host=attacker.invalid")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp.StatusCode, string(body)
	}
	if code, body := call(a, "/", "GET"); code != 200 || body != "alpha|"+a+"|https||" {
		t.Fatalf("A: %d %q", code, body)
	}
	if code, body := call(b, "/", "GET"); code != 200 || body != "beta|"+b+"|https||" {
		t.Fatalf("B: %d %q", code, body)
	}
	if code, body := call(a, "/404", "GET"); code != 404 || body != "origin 404" {
		t.Fatalf("404: %d %s", code, body)
	}
	if code, _ := call(a, "/ambiguous", "POST"); code != 502 || writes.Load() != 1 {
		t.Fatalf("POST status=%d writes=%d", code, writes.Load())
	}
	ws, _, err := websocket.Dial(ctx, "wss://"+base+"/ws", &websocket.DialOptions{Host: a, HTTPClient: client})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	if err = ws.Write(ctx, websocket.MessageText, []byte("live")); err != nil {
		t.Fatal(err)
	}
	_, data, err := ws.Read(ctx)
	if err != nil || string(data) != "live" {
		t.Fatalf("echo: %q %v", data, err)
	}
	mu.Lock()
	delete(grants, hashToken("first"))
	mu.Unlock()
	g.refresh(ctx)
	if _, _, err = ws.Read(ctx); err == nil {
		t.Fatal("revoked stream survived")
	}
	revoked, _, err := websocket.Dial(ctx, "wss://"+base+"/connect", &websocket.DialOptions{
		HTTPClient:   hostClient,
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer first"}},
		Subprotocols: []string{protocol},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err = revoked.Read(ctx); websocket.CloseStatus(err) != credentialRejected {
		t.Fatalf("revoked grant reported as %v", err)
	}
	if code, _ := call(a, "/", "GET"); code != 503 {
		t.Fatalf("unlinked: %d", code)
	}
	if code, _ := call(b, "/", "GET"); code != 200 {
		t.Fatalf("other tenant: %d", code)
	}
	ob.Close()
	if code, _ := call(b, "/", "GET"); code != 502 {
		t.Fatalf("closed origin: %d", code)
	}
}

type hostHeaderTransport struct {
	base http.RoundTripper
	host string
}

func (t hostHeaderTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Host = t.host
	return t.base.RoundTrip(clone)
}

func TestConnectorURL(t *testing.T) {
	for _, raw := range []string{"ws://connector.foo/", "wss://user@connector.beta.test/connect", "wss://connector.beta.test/connect?token=secret", "wss://connector.beta.test/public", "https://connector.beta.test/connect"} {
		if _, err := connectorURL(raw); err == nil {
			t.Errorf("accepted %s", raw)
		}
	}
	if _, err := connectorURL("wss://connector.beta.test/connect"); err != nil {
		t.Fatal(err)
	}
}
