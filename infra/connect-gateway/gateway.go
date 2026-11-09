package main

import (
	"context"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/libp2p/go-yamux/v5"
)

// A route outlives its last good check by the lease, so a relay outage shorter than it keeps
// hosts online. A relay refusal still closes the route at the next refresh.
const (
	lease           = 5 * time.Minute
	refreshInterval = 30 * time.Second
	checkTimeout    = 10 * time.Second
	admitTimeout    = 5 * time.Second
)

type route struct {
	hash, hostname string
	started        time.Time
	deadline       time.Time
	timer          *time.Timer
	disconnect     func()
	proxy          *httputil.ReverseProxy
	slots          chan struct{}
}

type gateway struct {
	connector, domain string
	authorize         authorizeFunc
	mu                sync.Mutex
	routes            map[string]*route
	// A hostname fences older admissions. A token hash fences only handshakes with that revoked grant.
	fences  map[string]time.Time
	shut    bool
	pending chan struct{}
}

func newGateway(connector string, authorize authorizeFunc) *gateway {
	return &gateway{
		connector: connector,
		domain:    strings.TrimPrefix((&url.URL{Host: connector}).Hostname(), "connector."),
		authorize: authorize,
		routes:    make(map[string]*route),
		fences:    make(map[string]time.Time),
		pending:   make(chan struct{}, 64),
	}
}

func (g *gateway) publicHost(host string) bool {
	label, ok := strings.CutSuffix(host, "."+g.domain)
	return ok && label != "connector" && dnsName(host) && !strings.Contains(label, ".")
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	host := strings.TrimSuffix(strings.ToLower(r.Host), ":443")
	if r.URL.IsAbs() || r.Method == http.MethodConnect {
		http.Error(w, "unsupported request", http.StatusBadRequest)
		return
	}
	if host == strings.TrimSuffix(g.connector, ":443") {
		if r.URL.EscapedPath() != "/connect" || r.URL.RawQuery != "" {
			http.NotFound(w, r)
			return
		}
		g.connect(w, r)
		return
	}
	if !g.publicHost(host) {
		http.NotFound(w, r)
		return
	}
	g.mu.Lock()
	rt := g.routes[host]
	if rt != nil && !time.Now().Before(rt.deadline) {
		rt = nil
	}
	g.mu.Unlock()
	if rt == nil {
		http.Error(w, "environment is offline", http.StatusServiceUnavailable)
		return
	}
	select {
	case rt.slots <- struct{}{}:
		defer func() { <-rt.slots }()
	default:
		http.Error(w, "environment connection limit", http.StatusTooManyRequests)
		return
	}
	rt.proxy.ServeHTTP(w, r)
}

func (g *gateway) connect(w http.ResponseWriter, r *http.Request) {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if r.Method != http.MethodGet || r.Header.Get("Origin") != "" || !ok || len(token) == 0 || len(token) > 1024 || strings.ContainsAny(token, " \t\n\r") || r.Header.Get("Sec-WebSocket-Protocol") != protocol {
		http.Error(w, "connector authorization required", http.StatusUnauthorized)
		return
	}
	select {
	case g.pending <- struct{}{}:
	default:
		http.Error(w, "busy", http.StatusTooManyRequests)
		return
	}
	started := time.Now()
	hash := hashToken(token)
	ctx, cancel := context.WithTimeout(r.Context(), admitTimeout)
	grants, err := g.authorize(ctx, []string{hash})
	cancel()
	<-g.pending
	if err != nil {
		http.Error(w, "authorization unavailable", http.StatusServiceUnavailable)
		return
	}
	host := grants[hash]
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol}})
	if err != nil {
		return
	}
	if !g.publicHost(host) {
		// A close code reaches every WebSocket client; an HTTP status does not.
		ws.Close(credentialRejected, "connector credential rejected")
		return
	}
	defer ws.CloseNow()
	conn := websocket.NetConn(r.Context(), ws, websocket.MessageBinary)
	tunnel, err := yamux.Client(conn, tunnelConfig(0), nil)
	if err != nil {
		return
	}
	rt := &route{
		hash: hash, hostname: host, started: started,
		slots: make(chan struct{}, maxStreams),
		proxy: proxyFor(host, tunnel),
		disconnect: func() {
			// Abort first. A cooperative WebSocket close can wait for an unresponsive peer.
			ws.CloseNow()
			tunnel.Close()
		},
	}
	defer rt.disconnect()
	ready, err := tunnel.OpenStream(r.Context())
	if err != nil {
		return
	}
	defer ready.Close()
	if !g.install(rt) {
		return
	}
	defer g.remove(rt)
	ready.SetWriteDeadline(time.Now().Add(2 * time.Second))
	if _, err := ready.Write([]byte{1}); err != nil {
		return
	}
	ready.Close()
	select {
	case <-tunnel.CloseChan():
	case <-r.Context().Done():
	}
}

func proxyFor(hostname string, tunnel *yamux.Session) *httputil.ReverseProxy {
	return &httputil.ReverseProxy{
		Rewrite: func(p *httputil.ProxyRequest) {
			p.Out.URL.Scheme = "http"
			p.Out.URL.Host = hostname
			p.Out.Host = hostname
			p.Out.URL.RawQuery = p.In.URL.RawQuery
			p.Out.Header.Del("X-Real-IP")
			p.Out.Header.Del("CF-Connecting-IP")
			p.Out.Header.Set("X-Forwarded-Proto", "https")
		},
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return tunnel.Open(ctx) },
			// Each request gets a fresh stream. In particular the Transport cannot retry a lost write on a reused connection.
			DisableKeepAlives: true,
			// /mcp holds a wait open for up to 50 s before it replies. Cloudflare tunnels allow 100 s.
			ResponseHeaderTimeout:  100 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
		},
		ErrorLog: log.New(io.Discard, "", 0),
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			http.Error(w, "environment origin unavailable", http.StatusBadGateway)
		},
	}
}

func (g *gateway) install(rt *route) bool {
	g.mu.Lock()
	old := g.routes[rt.hostname]
	if g.shut || !time.Now().Before(rt.started.Add(lease)) || (!rt.started.After(g.fences[rt.hostname]) || !rt.started.After(g.fences[rt.hash])) {
		g.mu.Unlock()
		return false
	}
	g.routes[rt.hostname] = rt
	g.fences[rt.hostname] = rt.started
	rt.deadline = rt.started.Add(lease)
	rt.timer = time.AfterFunc(time.Until(rt.deadline), func() { g.expire(rt) })
	if old != nil {
		old.timer.Stop()
	}
	g.mu.Unlock()
	if old != nil {
		old.disconnect()
	}
	return true
}

func (g *gateway) remove(rt *route) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.routes[rt.hostname] == rt {
		delete(g.routes, rt.hostname)
		rt.timer.Stop()
	}
}

func (g *gateway) expire(rt *route) {
	g.mu.Lock()
	if g.routes[rt.hostname] != rt || time.Now().Before(rt.deadline) {
		g.mu.Unlock()
		return
	}
	delete(g.routes, rt.hostname)
	g.mu.Unlock()
	rt.disconnect()
}

func (g *gateway) close() {
	g.mu.Lock()
	g.shut = true
	active := g.routes
	g.routes = make(map[string]*route)
	for _, rt := range active {
		rt.timer.Stop()
	}
	g.mu.Unlock()
	for _, rt := range active {
		rt.disconnect()
	}
}

func (g *gateway) refresh(ctx context.Context) {
	g.mu.Lock()
	cutoff := time.Now().Add(-lease)
	for host, fence := range g.fences {
		if !fence.After(cutoff) {
			delete(g.fences, host)
		}
	}
	current := make([]*route, 0, len(g.routes))
	for _, rt := range g.routes {
		current = append(current, rt)
	}
	g.mu.Unlock()
	var workers sync.WaitGroup
	slots := make(chan struct{}, 8)
	for batch := range slices.Chunk(current, batchSize) {
		slots <- struct{}{}
		workers.Go(func() {
			defer func() { <-slots }()
			g.renew(ctx, batch)
		})
	}
	workers.Wait()
}

func (g *gateway) renew(ctx context.Context, batch []*route) {
	hashes := make([]string, 0, len(batch))
	for _, rt := range batch {
		hashes = append(hashes, rt.hash)
	}
	started := time.Now()
	check, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	grants, err := g.authorize(check, hashes)
	if err != nil {
		// The independent lease timer closes stale streams even if the relay stalls.
		return
	}
	for _, rt := range batch {
		g.applyRenewal(rt, started, grants[rt.hash] == rt.hostname)
	}
}

func (g *gateway) applyRenewal(checked *route, started time.Time, allowed bool) {
	g.mu.Lock()
	current := g.routes[checked.hostname]
	if !allowed && started.After(g.fences[checked.hash]) {
		// Fence a delayed upgrade even when the checked connection has since disconnected.
		g.fences[checked.hash] = started
	}
	if current == nil || current.hash != checked.hash || current.started.After(started) {
		g.mu.Unlock()
		return
	}
	if !allowed || !time.Now().Before(current.deadline) {
		delete(g.routes, current.hostname)
		current.timer.Stop()
		g.mu.Unlock()
		current.disconnect()
		return
	}
	current.deadline = started.Add(lease)
	current.timer.Reset(time.Until(current.deadline))
	g.mu.Unlock()
}

func (g *gateway) runRefresh(ctx context.Context) {
	ticker := time.NewTicker(refreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			g.refresh(ctx)
		}
	}
}
