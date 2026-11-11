package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
)

// The relay accepts up to 256 token hashes per check.
const batchSize = 250
const maxResponseBytes = 1 << 20

type authorizeFunc func(context.Context, []string) (map[string]string, error)

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func relayAuthorizer(client *http.Client, endpoint, secret string) authorizeFunc {
	clientCopy := *client
	clientCopy.CheckRedirect = rejectRedirect
	return func(ctx context.Context, hashes []string) (map[string]string, error) {
		body, err := json.Marshal(struct {
			TokenHashes []string `json:"tokenHashes"`
		}{hashes})
		if err != nil {
			return nil, err
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+secret)
		req.Header.Set("Content-Type", "application/json")
		resp, err := clientCopy.Do(req)
		if err != nil {
			return nil, errors.New("relay authorization unavailable")
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return nil, errors.New("relay authorization refused")
		}
		var result struct {
			Routes []struct {
				TokenHash string `json:"tokenHash"`
				Hostname  string `json:"hostname"`
			} `json:"routes"`
		}
		data, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
		if err != nil || len(data) > maxResponseBytes || json.Unmarshal(data, &result) != nil || result.Routes == nil || len(result.Routes) > len(hashes) {
			return nil, errors.New("invalid relay authorization response")
		}
		routes := make(map[string]string, len(result.Routes))
		for _, r := range result.Routes {
			if !slices.Contains(hashes, r.TokenHash) || routes[r.TokenHash] != "" || !dnsName(r.Hostname) {
				return nil, errors.New("invalid relay route")
			}
			routes[r.TokenHash] = r.Hostname
		}
		return routes, nil
	}
}
