# Native Linux startup fixture

`capture.py` runs the built desktop, records the entire X display with timestamped action captions, saves native root screenshots, records artifact hashes and executable `process.versions`, and reads the clipboard with xclip on the same X session. A hidden Electron helper records executable versions. The helper and video captions are capture instrumentation; they do not replace application dialogs. Output contains runtime databases and must remain outside version control. Review logs for private data before uploading. A `.stop-captures` file in the output parent prevents subsequent captures from launching.

Prerequisites: built desktop/server/web assets, Python sqlite3, Electron, ffmpeg with drawtext, ImageMagick import, xdotool, xclip, Xvfb, D-Bus, GNOME keyring. No browser is used. Build each revision and save its main bundle at `.t3/evidence-head/main.cjs` and `.t3/evidence-base/main.cjs`, then pass the commits those builds came from as `--head-source` and `--base-source`. Both are required and must resolve to commits in the worktree, and both bundles must exist; the script exits before touching the checkout otherwise. The manifest records each ref, its resolved commit, and each saved bundle's hash. The script cannot prove a bundle was built from its ref, so name the refs you actually built. The script temporarily swaps only `dist-electron/main.cjs` and restores it in `finally`, including on SIGTERM, SIGHUP, or SIGINT, which also stop the processes it started. SIGKILL cannot be handled: after one, restore `main.cjs` and rename `bin.mjs.evidence-save` back by hand, and stop leftover processes listed in `pids.json`. An advisory lock serializes bundle swaps. Do not run other desktop instances from this checkout during capture or run captures concurrently. `missing-entry` temporarily renames the server entry and restores it: use only an isolated artifact checkout with no other app/server running.

To create a nonprivate seed, launch the built desktop once with a new empty task-local `T3CODE_HOME`, allow the backend to reach ready, then quit that captured process. Do not add projects or pair accounts. Check `projection_projects` and `projection_threads` both contain zero rows. Never use the live developer home.

Use that clean, stopped, isolated T3 home's `userdata/statev2.sqlite` as `--seed`. The SQLite backup API includes committed WAL state. The missing-column fixture drops `projection_threads.branch_pull_request_json` but retains the migration ledger. Invalid/unavailable use literal non-SQLite bytes, a different failure. `unavailable` makes `userdata/logs/server-child.log` a directory; this probes later write failure, but sink creation is lazy and still advertises a path. `unavailable-parent` makes `userdata/logs` a file so sink initialization cannot create its parent; it probes the no-op sink branch if application bootstrap can continue. Record actual behavior rather than assuming either fixture reaches the intended branch. Healthy uses an unchanged SQLite snapshot. No credentials, private data, or database fixtures belong in this directory.

Example, from the worktree, after saving/building both revisions and exporting `HEAD_REF` and `BASE_REF` as the commits they were built from:

```sh
worktree="$PWD"
export XDG_DATA_HOME="$worktree/.t3/keyring-data"
xvfb-run -a -s '-screen 0 1440x900x24' dbus-run-session -- bash -c '
  printf %s t3-fleet | gnome-keyring-daemon --unlock --components=secrets >/dev/null
  GTK_THEME=Adwaita:light python3 scripts/fixtures/issue-10517/capture.py \
    --worktree "$PWD" --output /tmp/issue10517-base \
    --seed .t3/healthy-home/userdata/statev2.sqlite \
    --variant missing-column --revision base --seconds 33 \
    --head-source "$HEAD_REF" --base-source "$BASE_REF"
'
```

Repeat with fresh output and `--revision head`, identical seed/display/theme/steps. Use `--action escape`, `close`, or `none` for cancellation/control. Probe 390 with a real 390-wide X screen, not a cropped image. GTK theme requests may not affect Electron's native toolkit; report observed appearance and actual dialog geometry rather than claiming theme coverage. No window manager is started. Captures are Linux X11 evidence only, not macOS, Windows, WSL, web, or mobile proof.
