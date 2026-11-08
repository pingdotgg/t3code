package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
	"github.com/libp2p/go-yamux/v5"
)

// connectHost attaches a test host the way the T3 server's connector does.
func connectHost(ctx context.Context, gatewayURL, token, addr string, client *http.Client, ready func()) error {
	handshake, cancel := context.WithTimeout(ctx, 10*time.Second)
	clientCopy := *client
	clientCopy.CheckRedirect = rejectRedirect
	ws, _, err := websocket.Dial(handshake, gatewayURL, &websocket.DialOptions{
		HTTPClient:   &clientCopy,
		HTTPHeader:   http.Header{"Authorization": []string{"Bearer " + token}},
		Subprotocols: []string{protocol},
	})
	cancel()
	if err != nil {
		return err
	}
	defer ws.CloseNow()
	if ws.Subprotocol() != protocol {
		return errors.New("gateway does not support the connector protocol")
	}
	life, stop := context.WithCancel(ctx)
	defer stop()
	mux, err := yamux.Server(websocket.NetConn(life, ws, websocket.MessageBinary), tunnelConfig(maxStreams), nil)
	if err != nil {
		return err
	}
	defer mux.Close()
	first, err := mux.AcceptStream()
	if err != nil {
		return err
	}
	var ack [1]byte
	_, err = io.ReadFull(first, ack[:])
	first.Close()
	if err != nil || ack[0] != 1 {
		return errors.New("gateway did not confirm the route")
	}
	ready()
	for {
		stream, err := mux.AcceptStream()
		if err != nil {
			return err
		}
		go func() {
			defer stream.Close()
			origin, err := net.Dial("tcp", addr)
			if err != nil {
				stream.Reset()
				return
			}
			defer origin.Close()
			go io.Copy(origin, stream)
			io.Copy(stream, origin)
		}()
	}
}
