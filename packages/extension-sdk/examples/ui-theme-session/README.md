# UI theme session consumer

Build with `node ../../bin/t3-extension.mjs build .`, then check `.t3-extension`.
Install into a disposable runtime with the `t3.ui/theme.read` and
`t3.ui/theme.write` grants and a project grant. The package re-exposes
`example.ui-theme-session/theme` with two methods: `getState` reads the
resolved theme state and `applySessionTheme` writes a session overlay through
`t3.ui/theme.setPreference`. Both forward the caller's `clientConnectionId`
routing hint so the adapter can bind the call to the client's own connection.
