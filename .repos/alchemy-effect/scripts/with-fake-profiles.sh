#!/bin/sh
# Supply fake credentials for every built-in auth provider, without writing profiles.
# Usage: ./scripts/with-fake-profiles.sh vpr test --tags local
# Environment credentials override saved profiles. Endpoint overrides are preserved
# so the wrapped command can use local emulators. This does not redirect cloud APIs.
set -eu

if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

export AWS_ACCESS_KEY_ID=AKIAFAKELOCALTESTONLY
export AWS_SECRET_ACCESS_KEY=alchemy-fake-local-secret-access-key
export AWS_SESSION_TOKEN=alchemy-fake-local-session-token
export AWS_ACCOUNT_ID=000000000000
export AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
export AWS_DEFAULT_REGION="$AWS_REGION"

export AXIOM_TOKEN=alchemy-fake-local-axiom-token
export AXIOM_API_KEY="$AXIOM_TOKEN"
export AXIOM_ORG_ID=alchemy-local

export CLOUDFLARE_ACCOUNT_ID=00000000000000000000000000000000
export CLOUDFLARE_API_TOKEN=alchemy-fake-local-cloudflare-token
export CLOUDFLARE_API_KEY=alchemy-fake-local-cloudflare-key
export CLOUDFLARE_EMAIL=alchemy-local@example.invalid
export CLOUDFLARE_ACCOUNT_EMAIL="$CLOUDFLARE_EMAIL"

export DOPPLER_TOKEN=alchemy-fake-local-doppler-token
export FLY_API_TOKEN=alchemy-fake-local-fly-token

export GITHUB_ACCESS_TOKEN=alchemy-fake-local-github-token
export GITHUB_TOKEN="$GITHUB_ACCESS_TOKEN"
export GH_TOKEN="$GITHUB_ACCESS_TOKEN"
export GH_ENTERPRISE_TOKEN="$GITHUB_ACCESS_TOKEN"
export GITHUB_ENTERPRISE_TOKEN="$GITHUB_ACCESS_TOKEN"

export HCLOUD_TOKEN=alchemy-fake-local-hetzner-token
export INFISICAL_TOKEN=alchemy-fake-local-infisical-token
export NEON_API_KEY=alchemy-fake-local-neon-key

export PLANETSCALE_API_TOKEN_ID=alchemy-fake-local-planetscale-id
export PLANETSCALE_API_TOKEN=alchemy-fake-local-planetscale-token
export PLANETSCALE_ORGANIZATION=alchemy-local

export PRISMA_SERVICE_TOKEN=alchemy-fake-local-prisma-token
export PRISMA_API_TOKEN="$PRISMA_SERVICE_TOKEN"
export RAILWAY_API_TOKEN=alchemy-fake-local-railway-token
export STRIPE_API_KEY=sk_test_alchemy_fake_local

# exec preserves arguments, signals, and the wrapped command's exit status.
exec "$@"
