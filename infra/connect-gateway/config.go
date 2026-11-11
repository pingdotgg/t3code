package main

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
)

func plainURL(raw, scheme string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != scheme || u.Hostname() == "" || u.User != nil || u.ForceQuery || u.RawQuery != "" || strings.Contains(raw, "#") {
		return nil, errors.New("invalid " + scheme + " URL")
	}
	return u, nil
}

func connectorURL(raw string) (*url.URL, error) {
	u, err := plainURL(raw, "wss")
	if err != nil || !strings.HasPrefix(u.Hostname(), "connector.") || !dnsName(u.Hostname()) || u.EscapedPath() != "/connect" {
		return nil, errors.New("gateway URL must be wss://connector.<domain>/connect")
	}
	return u, nil
}

func dnsName(host string) bool {
	if len(host) > 253 {
		return false
	}
	for _, part := range strings.Split(host, ".") {
		if part == "" || len(part) > 63 || part[0] == '-' || part[len(part)-1] == '-' {
			return false
		}
		for _, c := range part {
			if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
				return false
			}
		}
	}
	return true
}

func rejectRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
