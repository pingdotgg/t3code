import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";

import * as Electron from "electron";

const MIN_DURATION_MS = 280;
const MAX_DURATION_MS = 680;
const DURATION_DISTANCE_SCALE = 2_000;
const EASING = "cubic-bezier(.2,.8,.2,1)";
const TIMEOUT_MS = 6_000;

type SnapShotAnimationDetails = {
  readonly appName: string;
  readonly windowTitle: string;
  readonly appIconDataUrl?: string | undefined;
};

export type SnapShotAnimationDestination = {
  readonly frame: Electron.Rectangle;
  /** Unit coordinates in T3's content area; GNOME supplies the real compositor origin. */
  readonly relativeFrame?: Electron.Rectangle | undefined;
  readonly backgroundColor: string;
  readonly borderColor: string;
  readonly borderWidth: number;
  readonly cornerRadius: number;
  readonly scaleFactor: number;
  readonly details?: SnapShotAnimationDetails | undefined;
};

export function snapShotAnimationDurationMs(
  source: Electron.Rectangle,
  target: Electron.Rectangle,
): number {
  const distance = Math.hypot(
    source.x + source.width / 2 - target.x - target.width / 2,
    source.y + source.height / 2 - target.y - target.height / 2,
  );
  return (
    MAX_DURATION_MS -
    (MAX_DURATION_MS - MIN_DURATION_MS) * Math.exp(-distance / DURATION_DISTANCE_SCALE)
  );
}

type ActiveTransition = {
  readonly id: string;
  readonly source: Electron.Rectangle;
  readonly snapshotDataUrl: string;
  readonly overlays: Array<{
    readonly window: Electron.BrowserWindow;
    readonly requestedBounds: Electron.Rectangle;
    bounds: Electron.Rectangle;
  }>;
  details?: SnapShotAnimationDetails | undefined;
  timer?: Fiber.Fiber<void> | undefined;
  flight?: Promise<void> | undefined;
};

type SnapShotTransitionOptions = {
  readonly showWindow?: ((window: Electron.BaseWindow) => void) | undefined;
  readonly boundOverlayToCaptureDisplays?: boolean | undefined;
  readonly waitForCompositorFrame?: boolean | undefined;
  readonly alwaysOnTopLevel?:
    | NonNullable<Parameters<Electron.BrowserWindow["setAlwaysOnTop"]>[1]>
    | undefined;
};

export function snapShotAnimationOverlayBounds(
  displays: ReadonlyArray<Pick<Electron.Display, "bounds">>,
): Electron.Rectangle {
  const firstDisplay = displays[0];
  const first = firstDisplay?.bounds ?? { x: 0, y: 0, width: 1, height: 1 };
  let left = first.x;
  let top = first.y;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const display of displays.slice(1)) {
    const bounds = display.bounds;
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function snapShotAnimationDisplayBounds(
  displays: ReadonlyArray<Pick<Electron.Display, "bounds">>,
  source: Electron.Rectangle,
  destination: Electron.Rectangle,
): Array<Electron.Rectangle> {
  const flight = snapShotAnimationOverlayBounds([{ bounds: source }, { bounds: destination }]);
  return displays
    .map((display) => display.bounds)
    .filter(
      (bounds) =>
        bounds.x < flight.x + flight.width &&
        bounds.x + bounds.width > flight.x &&
        bounds.y < flight.y + flight.height &&
        bounds.y + bounds.height > flight.y,
    );
}

function createWindow(
  bounds: Electron.Rectangle,
  alwaysOnTopLevel: SnapShotTransitionOptions["alwaysOnTopLevel"],
): Electron.BrowserWindow {
  const window = new Electron.BrowserWindow({
    ...bounds,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    focusable: false,
    frame: false,
    hasShadow: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "T3 Code Snapshot Animation",
    transparent: true,
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (alwaysOnTopLevel) window.setAlwaysOnTop(true, alwaysOnTopLevel);
  window.setIgnoreMouseEvents(true);
  return window;
}

function transitionHtml(
  sourceBounds: Electron.Rectangle,
  overlayBounds: Electron.Rectangle,
  flash: boolean,
): string {
  const source = {
    x: sourceBounds.x - overlayBounds.x,
    y: sourceBounds.y - overlayBounds.y,
    width: sourceBounds.width,
    height: sourceBounds.height,
  };
  return `<!doctype html><style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}
#card{position:absolute;left:${source.x}px;top:${source.y}px;width:${source.width}px;height:${source.height}px;contain:strict;overflow:hidden;border-radius:12px;background:#fff;box-shadow:0 24px 70px rgba(0,0,0,.24);transform-origin:center;will-change:transform}
#content{position:absolute;inset:0;overflow:hidden;border-radius:inherit;transform-origin:center;will-change:transform}
#snapshot{position:absolute;inset:0;width:100%;height:100%;object-fit:fill;transform-origin:center;will-change:transform}
#flash{position:absolute;inset:0;background:#fff;opacity:0;${flash ? "" : "display:none"}}
#details{--scale:1;position:absolute;inset-inline:0;bottom:0;display:flex;align-items:center;gap:calc(6px * var(--scale));padding:calc(24px * var(--scale)) calc(10px * var(--scale)) calc(8px * var(--scale));background:linear-gradient(to top,rgba(0,0,0,.85),rgba(0,0,0,.55),transparent);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;opacity:0}
#details:not([data-ready]){visibility:hidden}
#icon,#fallback{width:calc(28px * var(--scale));height:calc(28px * var(--scale));flex:none;border-radius:calc(6px * var(--scale))}
#icon{display:none;object-fit:cover}
#fallback{display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.2);color:#fff;font-size:calc(10px * var(--scale));font-weight:500;text-transform:uppercase}
#copy{min-width:0;flex:1}#app,#title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:calc(14px * var(--scale))}
#app{color:#fff;font-size:calc(11px * var(--scale));font-weight:500}#title{color:rgba(255,255,255,.7);font-size:calc(9px * var(--scale))}
#border{position:absolute;z-index:2;inset:0;box-sizing:border-box;border:0 solid transparent;border-radius:inherit;opacity:0}
</style><div id="card"><div id="content"><img id="snapshot"><div id="details"><img id="icon"><div id="fallback"></div><div id="copy"><div id="app"></div><div id="title"></div></div></div></div><div id="border"></div><div id="flash"></div></div><script>
const source=${JSON.stringify(source)},card=document.getElementById("card"),content=document.getElementById("content"),snapshot=document.getElementById("snapshot"),details=document.getElementById("details"),border=document.getElementById("border");
const afterPaint=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
window.setCaptureSnapshot=async src=>{snapshot.src=src;await snapshot.decode();await afterPaint()};
window.rebaseCaptureSource=next=>{Object.assign(source,next);Object.assign(card.style,{left:source.x+"px",top:source.y+"px",width:source.width+"px",height:source.height+"px"})};
window.startCaptureFlash=()=>document.getElementById("flash").animate([{opacity:.08},{offset:.38,opacity:.08},{offset:.68,opacity:.02},{opacity:0}],{duration:300,fill:"forwards",easing:"${EASING}"});
const applyDetails=value=>{
  if(!value)return;
  details.dataset.ready="";
  document.getElementById("app").textContent=value.appName;
  document.getElementById("title").textContent=value.windowTitle||"Captured window";
  document.getElementById("fallback").textContent=value.appName.slice(0,1);
  if(value.appIconDataUrl){
    const icon=document.getElementById("icon");icon.src=value.appIconDataUrl;icon.style.display="block";document.getElementById("fallback").style.display="none";
  }
};
window.updateCaptureDetails=applyDetails;
window.prepareCaptureTransition=async destination=>{
  const target=destination.frame,borderWidth=Math.min(Math.max(0,destination.borderWidth),Math.max(0,(Math.min(target.width,target.height)-1)/2));
  const inner={width:Math.max(1,target.width-borderWidth*2),height:Math.max(1,target.height-borderWidth*2)};
  const sourceCenter={x:source.x+source.width/2,y:source.y+source.height/2},targetCenter={x:target.x+target.width/2,y:target.y+target.height/2};
  const initial="translate3d("+(sourceCenter.x-targetCenter.x)+"px,"+(sourceCenter.y-targetCenter.y)+"px,0) scale("+(source.width/target.width)+","+(source.height/target.height)+")";
  const imageWidth=Math.max(1,snapshot.naturalWidth||source.width),imageHeight=Math.max(1,snapshot.naturalHeight||source.height),cover=Math.max(inner.width/imageWidth,inner.height/imageHeight);
  Object.assign(card.style,{left:target.x+"px",top:target.y+"px",width:target.width+"px",height:target.height+"px",borderRadius:destination.cornerRadius+"px",backgroundColor:destination.backgroundColor,boxShadow:"none"});
  Object.assign(content.style,{inset:borderWidth+"px",borderRadius:Math.max(0,destination.cornerRadius-borderWidth)+"px"});
  Object.assign(border.style,{borderWidth:borderWidth+"px",borderColor:destination.borderColor});
  details.style.setProperty("--scale",String(destination.scaleFactor));
  applyDetails(destination.details);
  const options={duration:destination.durationMs,fill:"forwards",easing:"${EASING}"};
  const animations=[
    card.animate([{transform:initial},{transform:"translate3d(0,0,0) scale(1)"}],options),
    content.animate([{transform:"scale("+(target.width/inner.width)+","+(target.height/inner.height)+")"},{transform:"scale(1)"}],options),
    snapshot.animate([{transform:"scale(1)"},{transform:"scale("+((imageWidth*cover)/inner.width)+","+((imageHeight*cover)/inner.height)+")"}],options),
    border.animate([{opacity:0},{opacity:1}],options),
    details.animate([{opacity:0},{opacity:1}],{delay:Math.max(0,destination.durationMs-125),duration:125,fill:"both",easing:"ease-in"})
  ];
  for(const animation of animations){animation.pause();animation.currentTime=0}
  window.playCaptureTransition=async()=>{
    for(const animation of animations)animation.play();
    await Promise.all(animations.map(animation=>animation.finished.catch(()=>undefined)));
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  };
  await afterPaint();
};
</script>`;
}

export class SnapShotTransition {
  private active: ActiveTransition | undefined;
  private readonly boundOverlayToCaptureDisplays: boolean;
  private readonly waitForCompositorFrame: boolean;
  private readonly alwaysOnTopLevel: SnapShotTransitionOptions["alwaysOnTopLevel"];
  private readonly showWindow: (window: Electron.BaseWindow) => void;

  constructor(options: SnapShotTransitionOptions = {}) {
    this.boundOverlayToCaptureDisplays = options.boundOverlayToCaptureDisplays ?? false;
    this.waitForCompositorFrame = options.waitForCompositorFrame ?? false;
    this.alwaysOnTopLevel = options.alwaysOnTopLevel;
    this.showWindow = options.showWindow ?? ((window) => window.showInactive());
  }

  async begin(
    id: string,
    source: Electron.Rectangle,
    snapshotDataUrl: string,
    flash: boolean,
    destinationWindowBounds?: Electron.Rectangle,
  ): Promise<void> {
    this.dispose();
    const sourceDisplay = Electron.screen.getDisplayMatching(source);
    const requestedBounds = this.boundOverlayToCaptureDisplays
      ? snapShotAnimationDisplayBounds(
          [
            sourceDisplay,
            ...Electron.screen.getAllDisplays().filter((d) => d.id !== sourceDisplay.id),
          ],
          source,
          destinationWindowBounds ?? source,
        )
      : [snapShotAnimationOverlayBounds(Electron.screen.getAllDisplays())];
    const active: ActiveTransition = {
      id,
      source,
      snapshotDataUrl,
      overlays: [],
    };
    active.timer = Effect.runFork(
      Effect.sleep(TIMEOUT_MS).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.active === active) this.dispose();
          }),
        ),
      ),
    );
    this.active = active;
    try {
      await this.showOverlays(active, requestedBounds, flash);
    } catch (error) {
      if (this.active === active) this.dispose();
      throw error;
    }
  }

  private async showOverlays(
    active: ActiveTransition,
    requestedBounds: ReadonlyArray<Electron.Rectangle>,
    flash: boolean,
  ): Promise<void> {
    const overlays: ActiveTransition["overlays"] = [];
    try {
      for (const bounds of requestedBounds) {
        const window = createWindow(bounds, this.alwaysOnTopLevel);
        const overlay = { window, requestedBounds: bounds, bounds: window.getBounds() };
        active.overlays.push(overlay);
        overlays.push(overlay);
      }
      await Promise.all(
        overlays.map(async (overlay) => {
          await overlay.window.loadURL(
            "data:text/html;charset=utf-8," +
              encodeURIComponent(transitionHtml(active.source, overlay.bounds, flash)),
          );
          if (this.active === active && !overlay.window.isDestroyed()) {
            await overlay.window.webContents.executeJavaScript(
              `window.setCaptureSnapshot(${JSON.stringify(active.snapshotDataUrl)})`,
            );
          }
        }),
      );
      for (const overlay of overlays) {
        if (this.active !== active) return;
        if (overlay.window.isDestroyed()) continue;
        this.showWindow(overlay.window);
        const bounds = overlay.window.getBounds();
        if (
          bounds.x !== overlay.bounds.x ||
          bounds.y !== overlay.bounds.y ||
          bounds.width !== overlay.bounds.width ||
          bounds.height !== overlay.bounds.height
        ) {
          overlay.bounds = bounds;
          await overlay.window.webContents.executeJavaScript(
            `window.rebaseCaptureSource(${JSON.stringify({
              x: active.source.x - bounds.x,
              y: active.source.y - bounds.y,
              width: active.source.width,
              height: active.source.height,
            })})`,
          );
        }
      }
      if (this.waitForCompositorFrame) {
        // Cover the source with a composited snapshot before the caller reveals T3.
        // Decoding and renderer animation frames alone can leave a transparent gap.
        await Promise.all(
          overlays.map(async (overlay) => {
            if (this.active !== active || overlay.window.isDestroyed()) return;
            await overlay.window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
          }),
        );
      }
      if (this.active !== active) return;
      if (flash) {
        await Promise.all(
          overlays.map(async (overlay) => {
            if (overlay.window.isDestroyed()) return;
            await overlay.window.webContents
              .executeJavaScript("window.startCaptureFlash()")
              .catch(() => undefined);
          }),
        );
      }
    } catch (error) {
      for (const overlay of overlays) {
        if (!overlay.window.isDestroyed()) overlay.window.destroy();
      }
      throw error;
    }
  }

  animateTo(id: string, destination: SnapShotAnimationDestination): void {
    const active = this.active;
    if (!active || active.id !== id) return;
    if (destination.details) active.details = destination.details;
    if (active.flight) {
      if (destination.details) {
        for (const overlay of active.overlays) {
          if (overlay.window.isDestroyed()) continue;
          void overlay.window.webContents
            .executeJavaScript(
              "window.updateCaptureDetails(" + JSON.stringify(destination.details) + ")",
            )
            .catch(() => undefined);
        }
      }
      return;
    }
    active.flight = this.runFlight(active, destination);
  }

  private async runFlight(
    active: ActiveTransition,
    destination: SnapShotAnimationDestination,
  ): Promise<void> {
    if (this.active !== active) return;
    if (this.boundOverlayToCaptureDisplays) {
      const missingBounds = snapShotAnimationDisplayBounds(
        Electron.screen.getAllDisplays(),
        active.source,
        destination.frame,
      ).filter(
        (bounds) =>
          !active.overlays.some(
            (overlay) =>
              !overlay.window.isDestroyed() &&
              overlay.requestedBounds.x === bounds.x &&
              overlay.requestedBounds.y === bounds.y &&
              overlay.requestedBounds.width === bounds.width &&
              overlay.requestedBounds.height === bounds.height,
          ),
      );
      if (missingBounds.length > 0) {
        await this.showOverlays(active, missingBounds, false).catch(() => undefined);
      }
    }
    if (this.active !== active) return;
    const durationMs = snapShotAnimationDurationMs(active.source, destination.frame);
    const prepared = await Promise.allSettled(
      active.overlays.map(async (overlay) => {
        if (overlay.window.isDestroyed()) return;
        await overlay.window.webContents.executeJavaScript(
          `window.prepareCaptureTransition(${JSON.stringify({
            ...destination,
            frame: {
              x: destination.frame.x - overlay.bounds.x,
              y: destination.frame.y - overlay.bounds.y,
              width: destination.frame.width,
              height: destination.frame.height,
            },
            borderWidth: Math.max(0, destination.borderWidth),
            cornerRadius: Math.max(0, destination.cornerRadius),
            scaleFactor: Math.max(0.1, destination.scaleFactor),
            details: active.details,
            durationMs,
          })})`,
        );
        if (this.active !== active || overlay.window.isDestroyed()) return;
        if (this.waitForCompositorFrame) {
          // Read back one pixel after preparation to flush queued compositor work
          // before the animation clock starts on any of the display surfaces.
          await overlay.window.webContents.capturePage({ x: 0, y: 0, width: 1, height: 1 });
        }
        return overlay;
      }),
    );
    if (this.active !== active) return;
    // One display failing must not cut the flight short on the others.
    await Promise.allSettled(
      prepared.map((result) => {
        if (result.status !== "fulfilled" || !result.value || result.value.window.isDestroyed()) {
          return;
        }
        return result.value.window.webContents.executeJavaScript("window.playCaptureTransition()");
      }),
    );
  }

  async waitForLanding(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    await active.flight?.catch(() => undefined);
  }

  async complete(id: string): Promise<void> {
    const active = this.active;
    if (!active || active.id !== id) return;
    await this.waitForLanding(id);
    if (this.active === active) this.dispose();
  }

  dismiss(id: string): void {
    if (this.active?.id === id) this.dispose();
  }

  dispose(): void {
    const active = this.active;
    this.active = undefined;
    if (!active) return;
    active.timer?.interruptUnsafe();
    for (const overlay of active.overlays) {
      if (!overlay.window.isDestroyed()) overlay.window.destroy();
    }
  }
}
