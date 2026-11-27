import type { DatabaseMigrationProgress } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type { DesktopAssets } from "../app/DesktopAssets.ts";

export const startupSplashBackground = "#14110f";

export const loadStartupArtwork = Effect.fn("desktop.splash.loadArtwork")(function* (
  resolve: DesktopAssets["Service"]["resolveResourcePath"],
) {
  const fs = yield* FileSystem.FileSystem;
  const asset = (name: string, mime: string) =>
    resolve(`startup/${name}`).pipe(
      Effect.flatMap((path) =>
        Option.match(path, {
          onNone: () => Effect.succeed(""),
          onSome: (file) =>
            fs
              .readFile(file)
              .pipe(
                Effect.map(
                  (bytes) => `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
                ),
              ),
        }),
      ),
      Effect.orElseSucceed(() => ""),
    );
  return yield* Effect.all(
    {
      animation: asset("oni.webp", "image/webp"),
      still: asset("oni-still.webp", "image/webp"),
      mark: asset("ryoku-dither.webp", "image/webp"),
      font: asset("geologica.woff2", "font/woff2"),
    },
    { concurrency: "unbounded" },
  );
});

export function buildStartupSplashDataUrl(
  art: Effect.Success<ReturnType<typeof loadStartupArtwork>>,
  progress: DatabaseMigrationProgress | null,
  animate: boolean,
): string {
  const label = progress ? `Upgrading database (${progress.current} of ${progress.total})` : "";
  const source = (animate && art.animation) || art.still;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:">
<title>Hyakki</title><style>
${art.font ? `@font-face{font-family:Geologica;src:url(${art.font}) format('woff2');font-weight:100 900;font-display:swap}` : ""}
*{box-sizing:border-box}
html,body{margin:0;width:100%;height:100%;overflow:hidden}
body{color-scheme:dark;background:${startupSplashBackground};color:#f5e7dc;font-family:Geologica,system-ui,sans-serif;user-select:none;-webkit-app-region:drag}
main{position:absolute;inset:0;isolation:isolate;display:flex;align-items:center;justify-content:center}
${art.mark ? `main::before{content:"";position:absolute;z-index:-1;inset:0;background:url(${art.mark}) 43% 40%/min(65vw,105vh) auto no-repeat;opacity:.17;mask-image:radial-gradient(ellipse 58% 64% at 45% 43%,#000 33%,transparent 98%)}` : ""}
.lockup{display:flex;align-items:center;justify-content:center;gap:min(5vw,9vh);padding-inline:6vw}
.wordmark{white-space:nowrap;display:grid;gap:min(1.5vw,2.5vh);transform:translateY(-1vh)}
.wordmark span{font-size:min(3vw,5.9vh);font-weight:480;letter-spacing:.045em;color:#c5a999;line-height:1.2}
h1{margin:0;line-height:1.01;font-size:min(10.25vw,19.6vh);font-weight:740;letter-spacing:-.039em}
picture{display:block;flex:none;width:min(39vw,74vh);aspect-ratio:1}
.oni{display:block;width:100%;height:100%;object-fit:contain}
.status{position:absolute;bottom:7%;margin:0;color:#c5a999;font-size:12px}
${animate ? `.wordmark span{animation:inscribe 440ms 200ms both cubic-bezier(.2,.7,.1,1)}h1{animation:inscribe 620ms 310ms both cubic-bezier(.2,.7,.1,1)}` : ""}
@keyframes inscribe{from{clip-path:inset(0 100% -18% 0);opacity:.42;translate:-2vw 0}to{clip-path:inset(0 0 -18% 0);opacity:1;translate:0 0}}
@media(prefers-reduced-motion:reduce){.wordmark span,h1{animation:none}}
</style></head><body><main aria-label="Hyakki is starting"><div class="lockup"><div class="wordmark"><span>Ryoku</span><h1>Hyakki</h1></div>
${source ? `<picture>${art.still ? `<source media="(prefers-reduced-motion: reduce)" srcset="${art.still}">` : ""}<img class="oni" src="${source}" width="440" height="440" alt=""></picture>` : ""}
</div>${label ? `<p class="status" role="status">${label}</p>` : ""}</main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
