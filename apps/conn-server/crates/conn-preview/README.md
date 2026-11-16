# conn-preview

Server-owned Chromium for the agent browser, client live views and HTML captures.
The single Tokio runtime drives CDP over fd 3/4. Blocking spawn, extraction and
large JSON or base64 work run on `spawn_blocking`.

Chrome starts on demand. The installer uses T3's generated version, archive size
and SHA-256, under `<base>/tools/chrome-headless-shell/<platform>/<version>/`.
It never searches PATH for a system browser. The container needs Chrome's Linux
shared libraries and a nonroot user with a usable Chromium sandbox. The package
list and sandbox setup are in `apps/server/src/preview/PreviewBrowserHost.ts`.
T3's explicit `T3CODE_SERVER_BROWSER_SANDBOX=0` override is also supported.

One server permits 32 tabs, eight per agent, four browser hosts, eight viewers per
tab, two simultaneous recordings and two HTML captures. Tabs without a viewer
expire after 30 minutes; empty hosts stop after five minutes, checked every minute.
Recordings stop accepting frames after five minutes or 50 MiB. CDP limits each
message to 36 MiB and queues 16 commands; each host retains 64 diagnostic events
of at most 64 KiB. Each capture queues three frames of at most 8 MiB, with one
shared capture and decoder per viewed tab. The native target budget is 40 per
host, including recorder and startup pages. Profile catalogs allow 64 connected
reporters and 256 merged profiles.

The generated browser-side DOM code comes from pinned Playwright (Apache-2.0).
Its license and notice are in `LICENSE.playwright` and `NOTICE.playwright`.
