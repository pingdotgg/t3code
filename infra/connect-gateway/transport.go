package main

import (
	"io"

	"github.com/coder/websocket"
	"github.com/libp2p/go-yamux/v5"
)

const maxStreams = 64
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
