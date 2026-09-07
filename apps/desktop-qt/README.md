# @t3tools/desktop-qt

Qt/QML shell for T3 Code. Hosts the web app in a `WebEngineView` and lets the
window chrome be rearranged and themed from `~/.t3/shell/`.

Architecture, setup, and the QML/theme contracts: `docs/internals/desktop-qt.md`.

```sh
vp run dev                      # terminal 1: server + web
vp run dev:qt                   # terminal 2: build the shell, pair, launch
```

Focused native checks use temporary data and run offscreen:

```sh
vp run --filter @t3tools/desktop-qt test:qml
cmake -S apps/desktop-qt/tests/native -B apps/desktop-qt/build/tests/native
cmake --build apps/desktop-qt/build/tests/native
ctest --test-dir apps/desktop-qt/build/tests/native --output-on-failure
```

`ShellRuntime` covers reload and theme ownership. `ShellExamples` loads all
four examples at 640, 1000, and 1400 pixels, checking header text and dashboard
card bounds, long branch names, clipped icons, and scrolling to the last card. It uses a local
view-model fixture and a blank web page; no running server or pairing is needed.
