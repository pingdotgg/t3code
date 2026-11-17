# conn-preview

Server-owned Chromium for the agent browser, client live views and HTML captures.
The single Tokio runtime drives CDP over fd 3/4. Blocking spawn, extraction and
large JSON or base64 work run on `spawn_blocking`.

Chrome starts on demand. Development installs use T3's generated version, archive size
and SHA-256, under `<base>/tools/chrome-headless-shell/<platform>/<version>/`.
It never searches PATH for a system browser. The container needs Chrome's Linux
shared libraries and a nonroot user with a usable Chromium sandbox. The package
list and sandbox setup are in `apps/server/src/preview/PreviewBrowserHost.ts`.
T3's explicit `T3CODE_SERVER_BROWSER_SANDBOX=0` override is also supported.

Orbit sets `CONN_SERVER_BROWSER_PATH` to an absolute bundled shell path, keeping adjacent files; missing or mismatched binaries fail without downloading.
The release ships generated `chrome.json` beside the binary; leaving the variable unset keeps lazy development installs.

The generated browser-side DOM code comes from pinned Playwright (Apache-2.0).
Its license and notice are in `LICENSE.playwright` and `NOTICE.playwright`.
