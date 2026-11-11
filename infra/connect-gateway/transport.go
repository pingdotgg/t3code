package main

import (
	"io"

	"github.com/coder/websocket"
	"github.com/libp2p/go-yamux/v5"
)

// Requests in flight per host, WebSockets and streams included. One HTTP/2 client can open 100 at once.
const maxStreams = 256
const protocol = "t3-connect-v1"

// The host's connector stops retrying a token closed with this code.
const credentialRejected websocket.StatusCode = 4401

func tunnelConfig(incoming uint32) *yamux.Config {
	c := yamux.DefaultConfig()
	c.LogOutput = io.Discard
	c.MaxIncomingStreams = incoming
	c.MaxStreamWindowSize = 1024 * 1024
	return c
}
