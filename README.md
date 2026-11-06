Scratch repro drivers for issue 31783 (never ship; synthetic data only).
- session.sh: run under `headless-desktop` with a worktree path and an out dir; records DISPLAY, starts `vp run dev:desktop` with T3CODE_DEV_SEED=0 and CDP on $CDP_PORT.
- xptr.py: real XTest pointer motion/click and X window move/resize via ctypes (CDP mouse events bypass Electron's drag hit test).
- cdp.mjs: evaluate JS in the app page over CDP (observation only).
- measure.js: header drag-region, popover and Favorites button bounds.
- hover.sh / click.sh: hover the Favorites rail at y=20/30/38/43 and click inside/below the 40px strip; print :hover, tooltip text, pointer-event count.
Flow: dismiss welcome, Add project > Local folder (a scratch git repo), New thread, open the model picker, move the detached DevTools window aside, run hover.sh/click.sh.
