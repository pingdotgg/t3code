#!/bin/sh
set -eu
cd "$(dirname "$0")"
: "${T3_PEBBLE_INSTALL_STATE:?Missing T3 state path}"
: "${T3_PEBBLE_INSTALL_DOMAIN:?Missing Tailscale domain}"
tailscale cert --cert-file .tls/cert.pem --key-file .tls/key.pem "$T3_PEBBLE_INSTALL_DOMAIN" >/dev/null
T3_ORIGIN=$(bun -e 'const x = await Bun.file(process.env.T3_PEBBLE_INSTALL_STATE).json(); if (!x.origin) process.exit(1); console.log(x.origin)')
export T3_ORIGIN
exec ./run.sh
