# Fast iteration

GPUI has no hot reload by default; these are the fast paths, quickest first.

1. **Theme colors, live:** `CONN_GPUI_THEME_FILE=/path/theme.json scripts/run-app.sh`, or set it
   in the environment of a running `dev-watch.sh`. Edit and save the JSON (Conn's custom theme
   format, e.g. a copy of `crates/conn-theme/themes/dark-mono.json`): the app re-derives every
   token, shell tint and divider within ~0.3 s, no rebuild. Use it to tune contrast.
2. **Code, rebuild + relaunch with state:** `scripts/dev-watch.sh`. On every save under `crates/` it rebuilds
   incrementally (a few seconds), relaunches the bundled app and restores the selected thread,
   theme and right panel tab through the automation hook. A failed build leaves the app running.
3. **Rust hot patching (spike, not set up yet):** `gpui-pre` 0.3.11 has a `hot-reload` feature
   (Dioxus `subsecond`, run under `dx serve --hot-patch`, debug builds only) that patches edited
   functions into the running app. Threadbear does not use it; changes to types or struct
   layouts still need a rebuild.
