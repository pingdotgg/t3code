# Browser sessions mirror

Build with `node ../../bin/t3-extension.mjs build .`, then check `.t3-extension`.
Install into a disposable runtime with the `t3.browser/sessions` grant (and
`t3.browser/operate` for command verbs) plus a project grant. Invoke
`example.browser-sessions/mirror` through the public SDK API facade; this
package relays the host's typed `t3.browser/sessions` contract.

The mirror is metadata-only: session state, navigation provenance, and bounded
commands — no engine attachment, webview handle, or presentation slot.
`navigation.kind` distinguishes dispatch acceptance (`pending`) from
engine-reported loads (`loading`/`loaded`/`failed`); the engine field reports
`unavailable` until an authenticated desktop host registers. Command receipts
record acceptance, never engine execution.
