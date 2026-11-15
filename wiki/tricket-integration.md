---
type: Decision
title: Retired Tricket integration
description: Tricket coordination is removed; existing environment data is left untouched.
status: stable
generated:
  by: opencode/gpt-6.1-sol
  at: 2026-11-15T06:48:39+00:00
sources:
  - id: previous-runtime
    resource: https://github.com/NicholasZolton/t3code/commit/b769c2189b47d797f79f8edbe01b548b3892bc24
    title: Fork main with the Tricket integration before removal
  - id: original-integration
    resource: https://github.com/NicholasZolton/t3code/pull/76
    title: Initial Tricket integration and rollout
---

# Retired Tricket integration

The maintainer retired Tricket on November 15, 2026. This removal restores the
pre-Tricket code paths, including upstream's CLI, MCP registration, RPC contracts,
capabilities, and runtime composition. Settings, webhook handling, reconciliation,
and managed ticket/project execution are removed. Do not preserve or reintroduce
the connector during upstream syncs.

The old connector used its own SQLite database and the environment's secret
store, not an upstream database migration. Removal deliberately leaves that data
and all existing threads untouched; there is no startup cleanup or credential
revocation. A runtime still running the previous build retains its integration
until separately updated.[^previous-runtime]

The initial integration shipped through PR #76; this record remains only to
explain its retirement and retained data, not to describe an available feature.
[^original-integration]

[^previous-runtime]: The previous integration's coordinator and repository are preserved in commit history.

[^original-integration]: [Initial integration](https://github.com/NicholasZolton/t3code/pull/76), deployed November 13, 2026.
