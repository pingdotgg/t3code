# @t3tools/desktop-qt

Qt/QML shell for T3 Code. Hosts the web app in a `WebEngineView` and lets the
window chrome be rearranged and themed from `~/.t3/shell/`.

Architecture, setup, and the QML/theme contracts: `docs/internals/desktop-qt.md`.

```sh
vp run dev                      # terminal 1: server + web
pnpm dev:qt                     # terminal 2: build the shell, pair, launch
```
