#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> cargo fmt --all -- --check"
cargo fmt --all -- --check

echo "==> cargo clippy --workspace --all-targets -- -D warnings"
cargo clippy --workspace --all-targets -- -D warnings

echo "==> cargo test --workspace"
cargo test --workspace

# The shared GPUI-free core (conn-client, conn-state, conn-theme, conn-orbit, conn-ffi) is its own
# workspace at the repo root.
cd "$ROOT/../.."
echo "==> shared crates: cargo fmt --all -- --check"
cargo fmt --all -- --check
echo "==> shared crates: cargo clippy --workspace --all-targets -- -D warnings"
cargo clippy --workspace --all-targets -- -D warnings
echo "==> shared crates: cargo test --workspace"
cargo test --workspace

echo "==> all checks passed"
