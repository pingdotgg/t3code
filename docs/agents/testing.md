# Tests that protect app functionality

The user approved tests at two public interfaces: the mobile-facing backend API,
and the mobile client's connection and event handling. Exercise them together
through real WebSockets, a real backend, and real temporary session files.
Replace only the external Codex process with a deterministic stdio fixture.

Prioritize pairing, prompt/response streaming, tool output and changes, approvals
and questions, stopping a turn, provider failures, and restart/reconnect recovery.
A lost connection must not silently replay a prompt. Storage failures must not
hide an active turn or prevent Stop.

Do not test private helpers, styles, trivial wrappers, snapshots of component
trees, or internal call counts. Do not add a coverage target. New regression tests
must describe a user-visible failure and fail when that behavior breaks.

Use Node's built-in test runner. Tests must not need provider credentials or use
the developer's Codex home. These checks do not replace building and running the
Android app on a phone.

Run `npm test` for the behavior suite. For a focused regression, use
`node --test --test-name-pattern='<behavior>' apps/runtime/test/mobile.test.ts`.
Run `npm run typecheck:runtime` and `npm run typecheck:mobile` for interface changes.
CI also exports the Android bundle to catch broken imports and assets.
