# ADR 010: Human Input Interruption

## Status

Accepted for the initial lease implementation, with regression coverage.

## Decision

Observe native user keyboard and pointer activity at the Electron guest/window boundary and revoke or pause the conflicting automation lease. Do not implement a timing-based suppression window unless a supported platform demonstrates that CDP-dispatched input is reported through the same native event path.

## Evidence

The `input-origin` spike attached Electron's `before-input-event` listener to the guest and dispatched keyboard input through CDP. No `before-input-event` was emitted.

This contradicts the assumption that CDP keyboard input is necessarily indistinguishable from human input at this boundary. It does not prove every Electron version, platform, input method, or pointer path behaves identically.

## Requirements

- Cover keyboard, pointer, wheel, touch, IME, accessibility input, and DevTools interaction where available.
- Record the interruption reason and the command that was cancelled.
- Serialize lease transition and command cancellation so a late automation event cannot land after the user takes control.
- Keep a regression fixture for CDP keyboard and mouse dispatch on every supported desktop platform.
- Remove the undefined `shared` controller mode. Initial modes are `human`, `agent`, and `none`.
