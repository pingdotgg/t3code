# Plan: Add Provider Log Stream Lifecycle Management

## Summary

Ensure `ProviderManager` logging stream is initialized, rotated/structured, and closed safely.

## Motivation

- `apps/desktop/src/providerManager.ts` opens a write stream in constructor.
- Stream lifecycle is not explicit on shutdown.

## Scope

- Desktop provider logging behavior.
- App shutdown integration.

## Proposed Changes

1. Add explicit `dispose()` on `ProviderManager`:
   - Remove event listeners
   - End/close log stream
2. Call `providerManager.dispose()` from app shutdown path in `apps/desktop/src/main.ts`.
3. Optional: change log format to JSON lines with stable fields.
4. Optional: per-session log files under `.logs/providers/`.

## Risks

- Improper close sequencing may lose final log lines.

## Validation

- Manual run/quit cycle to ensure no open handle warnings.
- Confirm logs flush on quit and file descriptors are not leaked.

## Done Criteria

- ProviderManager owns complete log stream lifecycle.
- Shutdown path explicitly disposes provider resources.
