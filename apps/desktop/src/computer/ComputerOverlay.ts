// @effect-diagnostics globalTimers:off -- The overlay fade is a plain Electron callback outside any Effect fiber.
import * as Electron from "electron";
import { APP_NAME } from "@t3tools/shared/branding";

const LINGER_MS = 1_500;
const FADE_MS = 400;
const SIZE = 48;

export type ComputerOverlaySpot = {
  readonly x: number;
  readonly y: number;
  readonly mode: "background" | "pointer";
};

export type ComputerOverlay = {
  readonly show: (spot: ComputerOverlaySpot) => void;
  readonly end: () => void;
};

const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;pointer-events:none}
#c{position:fixed;width:26px;height:26px;margin:-13px 0 0 -13px;border-radius:50%;opacity:0;
   box-shadow:0 0 0 2px rgba(43,108,255,.9),0 0 12px 3px rgba(43,108,255,.5)}
#c.on{opacity:1}
#c.fade{opacity:0;transition:opacity ${FADE_MS}ms ease-out}
#c.pointer{background:rgba(43,108,255,.9)}
#c.background{background:rgba(43,108,255,.18)}
</style><div id="c"></div><script>
const c=document.getElementById('c');
window.adaCursor=(x,y,mode)=>{c.style.left=x+'px';c.style.top=y+'px';c.className='on '+(mode==='pointer'?'pointer':'background')};
window.adaHide=()=>{c.className='fade '+c.className.replace(/\\b(on|fade)\\b/g,'').trim()};
</script>`;

function createOverlayWindow(): Electron.BrowserWindow {
  const window = new Electron.BrowserWindow({
    width: 1,
    height: 1,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: `${APP_NAME} Computer Use Overlay`,
    transparent: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.setAlwaysOnTop(true, "screen-saver");
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setIgnoreMouseEvents(true);
  return window;
}

export function createComputerOverlay(): ComputerOverlay {
  let window: Electron.BrowserWindow | null = null;
  let loaded = false;
  let pending: ComputerOverlaySpot | null = null;
  let fadeTimer: NodeJS.Timeout | null = null;

  const clearTimer = () => {
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = null;
  };

  const schedule = (fn: () => void, ms: number) => {
    fadeTimer = setTimeout(fn, ms);
    fadeTimer.unref();
  };

  const run = (target: Electron.BrowserWindow, script: string) => {
    target.webContents.executeJavaScript(script).catch(() => undefined);
  };

  const apply = (target: Electron.BrowserWindow, spot: ComputerOverlaySpot) => {
    // Only as big as the marker, so an accessibility hit test elsewhere never lands on it.
    target.setBounds({
      x: Math.round(spot.x - SIZE / 2),
      y: Math.round(spot.y - SIZE / 2),
      width: SIZE,
      height: SIZE,
    });
    run(target, `window.adaCursor(${SIZE / 2},${SIZE / 2},${JSON.stringify(spot.mode)})`);
    if (!target.isVisible()) target.showInactive();
    clearTimer();
    schedule(() => {
      if (target.isDestroyed()) return;
      run(target, "window.adaHide()");
      schedule(() => {
        if (!target.isDestroyed()) target.hide();
      }, FADE_MS);
    }, LINGER_MS);
  };

  const build = (): Electron.BrowserWindow | null => {
    try {
      const built = createOverlayWindow();
      loaded = false;
      built.webContents.once("did-finish-load", () => {
        if (built !== window || built.isDestroyed()) return;
        loaded = true;
        const spot = pending;
        pending = null;
        if (spot) apply(built, spot);
      });
      built.once("closed", () => {
        if (built !== window) return;
        window = null;
        loaded = false;
        clearTimer();
      });
      void built.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(OVERLAY_HTML)}`);
      return built;
    } catch {
      return null;
    }
  };

  return {
    show: (spot) => {
      try {
        window ??= build();
        if (!window || window.isDestroyed()) {
          window = null;
          return;
        }
        if (!loaded) {
          pending = spot;
          return;
        }
        apply(window, spot);
      } catch {
        // Overlay is cosmetic; a failed show must not affect the action.
      }
    },
    end: () => {
      clearTimer();
      pending = null;
      loaded = false;
      const target = window;
      window = null;
      if (!target || target.isDestroyed()) return;
      try {
        target.hide();
        target.destroy();
      } catch {
        // Already gone.
      }
    },
  };
}
