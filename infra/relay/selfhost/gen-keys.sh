#!/bin/sh
# Creates the relay's cloud-mint signing key pair (Ed25519), keeping a private key that exists.
set -eu
dir="$(dirname "$0")/secrets"
mkdir -p "$dir"
private="$dir/cloud-mint-private.pem"
if [ -f "$private" ]; then
  echo "Keeping the existing $private."
else
  (umask 077 && openssl genpkey -algorithm ed25519 -out "$private")
fi
# Derived every run, so a missing or partial public key is repaired.
openssl pkey -in "$private" -pubout -out "$dir/cloud-mint-public.pem"
chmod 644 "$dir/cloud-mint-public.pem"
# Compose mounts secret files with their host owner, and the relay runs as the image's node user.
if [ "$(id -u)" = 0 ]; then
  chown 1000:1000 "$private"
elif [ "$(id -u)" != 1000 ]; then
  echo "The relay reads $private as uid 1000. Run: sudo chown 1000 $private" >&2
fi
echo "Keys are in $dir"
