# Version skew

A newer client connected to an older T3 Learn server offers only what that server can do. On 2026-11-05, a 0.1.7-learn.14 client showed New lesson against a 0.1.7-learn.2 server, and Start lesson did nothing (APP-56).

## Sub-features

- `skew-hidden`: against an older server, New lesson is missing from the sidebar and the command palette, and the selection toolbar offers no "Create lesson".
- `skew-shown`: against a same-version server, New lesson is offered.

## Driving it with the Browser panel

Preconditions: QA's web client at the sha under test. Run an older released server binary from `~/.t3-learn/runtime/versions/<version>/t3` against a sandbox home. Never point it at `~/.t3-learn/userdata`.

- **Old server.** `env -u T3CODE_HOME -u T3_BOOT_SERVICE_UNIT -u T3_SERVICE_LAUNCHER_CONTEXT setsid ~/.t3-learn/runtime/versions/0.1.7-learn.2/t3 serve --port <p> --host 127.0.0.1 --base-dir <sandbox>/home <sandbox>/proj &`. Keep its PID. Add a project with that binary's `project add --base-dir <sandbox>/home <sandbox>/proj`.
- **Client.** In the QA checkout's `apps/web`, run `T3CODE_PORT=<p> vp dev --port <w> --strictPort`, then pair with the `pair#token=` line from the server's output on `http://localhost:<w>/`.
- **Hidden.** `preview_evaluate` the sidebar's buttons: there is no `New lesson`. `preview_press` `k` with `Control` and read the palette: no `New lesson`.
- **Shown.** Repeat against QA's own server: `New lesson` is offered.

## Gotchas

- Vite can miss edits once the box runs out of file watchers (`ENOSPC` in its log). Restart it before trusting a result.
- Clicking Start lesson against a real provider starts a paid turn. The skew check needs only whether the entry point is offered.
