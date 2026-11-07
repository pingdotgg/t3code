#!/bin/sh
# Creates the relay's cloud-mint signing key pair (Ed25519). Run once and keep the private key.
set -eu
dir="$(dirname "$0")/secrets"
mkdir -p "$dir"
if [ -f "$dir/cloud-mint-private.pem" ]; then
  echo "Keys already exist in $dir; not overwriting them."
  exit 0
fi
openssl genpkey -algorithm ed25519 -out "$dir/cloud-mint-private.pem"
openssl pkey -in "$dir/cloud-mint-private.pem" -pubout -out "$dir/cloud-mint-public.pem"
chmod 600 "$dir/cloud-mint-private.pem"
echo "Wrote $dir/cloud-mint-private.pem and $dir/cloud-mint-public.pem"
