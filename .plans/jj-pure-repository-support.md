# Pure Jujutsu Repository Support Proposal

Status: follow-up proposal, not an official feature

## Goal

Support pure jj and non-colocated Git-backed repositories without weakening current colocated safety
or provider behavior.

## Required decisions

- Define provider identity when no `.git` worktree is available to hosting CLIs.
- Replace hidden Git checkpoint refs with a jj-native durable retention mechanism.
- Separate Git-provider compatibility capability from core repository capability.
- Decide whether provider CLIs run against a temporary compatibility checkout or provider APIs only.
- Prove clone, fetch, publish, review checkout, checkpoints, and recovery against supported backends.

## Constraints

- No implicit conversion to colocated mode.
- No repository-wide operation restore for thread rollback.
- No fictional current bookmark.
- No fallback from failed jj mutation to direct Git mutation.
- No provider command may require or synthesize user credentials outside existing secret handling.

## Acceptance boundary

- Shared workflow contracts and clients remain unchanged.
- Pure repositories pass driver, workspace, sync, review, and checkpoint suites.
- Provider-less local workflows work without Git.
- Hosted change requests expose explicit unsupported reasons until provider compatibility passes.
- Colocated repositories retain current behavior and performance.
