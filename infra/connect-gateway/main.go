package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil && ctx.Err() == nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(ctx context.Context, args []string) error {
	if len(args) != 1 || args[0] != "serve" {
		return errors.New("usage: t3-connect-gateway serve")
	}
	public, err := connectorURL(os.Getenv("T3_CONNECT_GATEWAY_URL"))
	if err != nil {
		return err
	}

	relay, err := plainURL(os.Getenv("T3_CONNECT_RELAY_URL"), "https")
	if err != nil || (relay.Path != "" && relay.Path != "/") {
		return errors.New("T3_CONNECT_RELAY_URL must be an HTTPS origin")
	}
	relay.Path = "/v1/gateway/authorize"
	secret := os.Getenv("T3_CONNECT_RELAY_SECRET")
	if len(secret) < 32 {
		return errors.New("T3_CONNECT_RELAY_SECRET must have at least 32 characters")
	}
	addr := os.Getenv("T3_CONNECT_LISTEN")
	if addr == "" {
		addr = "127.0.0.1:7443"
	}
	host, _, err := net.SplitHostPort(addr)
	if err != nil || !net.ParseIP(host).IsLoopback() {
		return errors.New("T3_CONNECT_LISTEN must be a loopback IP and port behind a TLS ingress")
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	g := newGateway(public.Host, relayAuthorizer(http.DefaultClient, relay.String(), secret))
	go g.runRefresh(ctx)
	server := &http.Server{
		Handler:           g,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    64 << 10,
	}
	done := make(chan struct{})
	stopShutdown := context.AfterFunc(ctx, func() { g.close(); server.Close(); close(done) })
	defer func() {
		if !stopShutdown() {
			<-done
		}
		g.close()
	}()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
