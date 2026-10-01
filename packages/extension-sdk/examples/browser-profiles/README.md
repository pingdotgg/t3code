# Browser profiles consumer

Build with `node ../../bin/t3-extension.mjs build .`, then check `.t3-extension`.
The package only declares `t3.browser/profiles`; call it through the SDK API
facade. Grant each capability separately — `t3.browser/profiles` (list, and
`open` together with `t3.browser/sessions` + `t3.browser/operate`),
`t3.browser/clear-cookies`, `t3.browser/clear-cache` and
`t3.browser/import-cookies`. Holding one grant never unlocks another method.
Every method needs the desktop app's browser engine; elsewhere it fails
`BrowserProfilesUnsupported … (desktop-required)`.
