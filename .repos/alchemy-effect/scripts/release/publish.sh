#!/usr/bin/env bash
set -euo pipefail

move_tag() {
  local spec="$1"
  local tag="$2"
  if [[ -z "${NPM_TOKEN:-}" ]]; then
    echo "::warning title=dist-tag ${tag} not moved::OIDC does not cover dist-tag changes. Run: pnpm dist-tag add ${spec} ${tag}"
    return
  fi
  if ! NODE_AUTH_TOKEN="$NPM_TOKEN" pnpm dist-tag add "$spec" "$tag"; then
    echo "::warning title=dist-tag ${tag} not moved::The configured NPM_TOKEN was rejected. Run: pnpm dist-tag add ${spec} ${tag}"
  fi
}

for tarball in release-packages/*.tgz; do
  spec=$(tar -xOf "$tarball" package/package.json | jq -r '"\(.name)@\(.version)"')
  if pnpm view "$spec" version >/dev/null 2>&1; then
    echo "$spec is already published; skipping tarball"
    if [[ "$FORCE_LATEST" == "true" ]]; then
      move_tag "$spec" latest
      if [[ "$CHANNEL_TAG" != "latest" ]]; then
        move_tag "$spec" "$CHANNEL_TAG"
      fi
    fi
    continue
  fi

  pnpm publish "$tarball" --access public --tag "$PUBLISH_TAG" --no-git-checks
  if [[ "$FORCE_LATEST" == "true" && "$CHANNEL_TAG" != "latest" ]]; then
    move_tag "$spec" "$CHANNEL_TAG"
  fi
done
