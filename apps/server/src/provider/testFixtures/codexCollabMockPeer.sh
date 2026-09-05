#!/usr/bin/env bash
# Wrapper so CodexSessionRuntime can spawn the mock peer: the runtime always
# passes "app-server" as the first argument (real codex CLI subcommand);
# discard it and exec node on the .mjs peer.
shift
exec node "$(dirname "$0")/codexCollabMockPeer.mjs" "$@"
