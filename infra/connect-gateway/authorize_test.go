package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestRelayAuthorization(t *testing.T) {
	const presented = "synthetic-connector-credential"
	const secret = "synthetic-relay-secret"
	const host = "a.beta.example"
	digest := hashToken(presented)
	var redirected atomic.Bool
	relay := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirected" {
			redirected.Store(true)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+secret || r.Method != http.MethodPost {
			t.Error("unprivileged relay request")
		}
		var message struct{ TokenHashes []string }
		if err := json.NewDecoder(r.Body).Decode(&message); err != nil || len(message.TokenHashes) != 1 || message.TokenHashes[0] != digest {
			t.Error("request did not contain only the connector digest")
		}
		switch r.URL.Path {
		case "/v1/gateway/authorize":
			json.NewEncoder(w).Encode(map[string]any{"routes": []map[string]string{{"tokenHash": digest, "hostname": host}}})
		case "/bad":
			json.NewEncoder(w).Encode(map[string]any{"routes": []map[string]string{{"tokenHash": hashToken("different token"), "hostname": host}}})
		case "/redirect":
			http.Redirect(w, r, "/redirected", http.StatusTemporaryRedirect)
		default:
			http.NotFound(w, r)
		}
	}))
	defer relay.Close()
	for _, p := range []string{"/v1/gateway/authorize", "/bad", "/redirect"} {
		authorize := relayAuthorizer(relay.Client(), relay.URL+p, secret)
		grants, err := authorize(t.Context(), []string{digest})
		if p == "/v1/gateway/authorize" {
			if err != nil || grants[digest] != host {
				t.Fatalf("grant: %v %v", grants, err)
			}
		} else if err == nil {
			t.Fatalf("accepted %s", p)
		}
	}
	if redirected.Load() {
		t.Fatal("relayed the control credential to a redirect")
	}
}

func TestLeaseExpiresDuringAuthorizationOutage(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		unblock := make(chan struct{})
		g := newGateway("connector.beta.example", func(context.Context, []string) (map[string]string, error) {
			<-unblock
			return nil, errors.New("unavailable")
		})
		defer g.close()
		var stopped atomic.Bool
		rt := &route{hash: "one", hostname: "a.beta.example", started: time.Now(), disconnect: func() { stopped.Store(true) }}
		if !g.install(rt) {
			t.Fatal("route not installed")
		}
		go g.refresh(t.Context())
		synctest.Wait()
		time.Sleep(lease)
		synctest.Wait()
		if !stopped.Load() {
			t.Error("stalled authorization kept route open")
		}
		close(unblock)
		synctest.Wait()
		if len(g.routes) != 0 {
			t.Error("expired route still present")
		}
	})
}

func TestSlowRelayKeepsHealthyRoutes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		g := newGateway("connector.beta.example", func(ctx context.Context, hashes []string) (map[string]string, error) {
			select {
			case <-time.After(checkTimeout / 2):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			routes := make(map[string]string, len(hashes))
			for _, hash := range hashes {
				routes[hash] = hash + ".beta.example"
			}
			return routes, nil
		})
		defer g.close()
		var dropped atomic.Int32
		for i := range 5000 {
			hash := fmt.Sprintf("h%d", i)
			if !g.install(&route{hash: hash, hostname: hash + ".beta.example", started: time.Now(), disconnect: func() { dropped.Add(1) }}) {
				t.Fatal("route not installed")
			}
		}
		ctx, stop := context.WithCancel(t.Context())
		go g.runRefresh(ctx)
		time.Sleep(3 * lease)
		stop()
		synctest.Wait()
		if n := dropped.Load(); n != 0 {
			t.Fatalf("a slow relay dropped %d healthy routes", n)
		}
	})
}

func TestReconnectStormIsAdmittedInBatches(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var mu sync.Mutex
		var calls [][]string
		g := newGateway("connector.beta.example", func(_ context.Context, hashes []string) (map[string]string, error) {
			mu.Lock()
			calls = append(calls, hashes)
			mu.Unlock()
			grants := make(map[string]string, len(hashes))
			for _, hash := range hashes {
				grants[hash] = hash + ".beta.example"
			}
			return grants, nil
		})
		defer g.close()
		// Every host of a restarted gateway is waiting before the first relay call; one connects twice.
		var hashes []string
		for i := range 600 {
			hashes = append(hashes, fmt.Sprintf("h%d", i))
		}
		hashes = append(hashes, "h599")
		results := make([]chan admitted, len(hashes))
		for i, hash := range hashes {
			results[i] = make(chan admitted, 1)
			g.admit <- admission{hash: hash, result: results[i]}
		}
		ctx, stop := context.WithCancel(t.Context())
		defer stop()
		go g.runAdmissions(ctx)
		synctest.Wait()
		for i, result := range results {
			select {
			case got := <-result:
				if got.err != nil || got.host != hashes[i]+".beta.example" {
					t.Fatalf("admission %d: %+v", i, got)
				}
			default:
				t.Fatalf("admission %d got no answer", i)
			}
		}
		sizes := make([]int, len(calls))
		for i, call := range calls {
			sizes[i] = len(call)
		}
		// Batches run in parallel, so they finish in any order.
		slices.Sort(sizes)
		if !slices.Equal(sizes, []int{100, batchSize, batchSize}) {
			t.Fatalf("relay calls carried %v hashes", sizes)
		}
	})
}

func TestStaleAuthorizationCannotRevokeReplacement(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		unblock := make(chan struct{})
		g := newGateway("connector.beta.example", func(context.Context, []string) (map[string]string, error) { <-unblock; return map[string]string{}, nil })
		defer g.close()
		const host = "a.beta.example"
		var oldClosed, newClosed bool
		old := &route{hash: "old", hostname: host, started: time.Now(), disconnect: func() { oldClosed = true }}
		if !g.install(old) {
			t.Fatal("old route not installed")
		}
		go g.refresh(t.Context())
		synctest.Wait()
		time.Sleep(time.Nanosecond)
		newRoute := &route{hash: "new", hostname: host, started: time.Now(), disconnect: func() { newClosed = true }}
		if !g.install(newRoute) || !oldClosed {
			t.Fatal("replacement did not evict the old transport")
		}
		if g.install(old) {
			t.Fatal("stale attach dislodged a newer session")
		}
		close(unblock)
		synctest.Wait()
		if newClosed || g.routes[host] != newRoute {
			t.Fatal("stale reply cleared the new transport")
		}
	})
}

func TestUnlinkFencesAnInFlightAttach(t *testing.T) {
	for _, disconnectFirst := range []bool{false, true} {
		synctest.Test(t, func(t *testing.T) {
			unblock := make(chan struct{})
			g := newGateway("connector.beta.example", func(context.Context, []string) (map[string]string, error) {
				<-unblock
				return map[string]string{}, nil
			})
			defer g.close()
			const host = "a.beta.example"
			active := &route{hash: "old", hostname: host, started: time.Now(), disconnect: func() {}}
			if !g.install(active) {
				t.Fatal("install failed")
			}
			time.Sleep(time.Nanosecond)
			pending := &route{hash: "old", hostname: host, started: time.Now(), disconnect: func() {}}
			time.Sleep(time.Nanosecond)
			go g.refresh(t.Context())
			synctest.Wait()
			if disconnectFirst {
				g.remove(active)
			}
			close(unblock)
			synctest.Wait()
			if g.install(pending) {
				t.Fatal("an older in-flight authorization reopened a revoked route")
			}
			replacement := &route{hash: "new", hostname: host, started: pending.started, disconnect: func() {}}
			if !g.install(replacement) {
				t.Fatal("revoking the old credential refused an independently authorized replacement")
			}
		})
	}
}
