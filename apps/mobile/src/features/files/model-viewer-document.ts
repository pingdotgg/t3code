import { ModelPreviewError } from "@t3tools/client-runtime/model-preview/error";
import { ZipError } from "@t3tools/client-runtime/zip/error";
import * as Schema from "effect/Schema";

import type { ModelViewerCommand, ModelViewerEvent } from "./model-viewer-protocol";

const Vec3 = Schema.Tuple([Schema.Number, Schema.Number, Schema.Number]);
const View = Schema.Struct({ position: Vec3, target: Vec3 });

const ModelViewerEventSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["ready", "crashed"]) }),
  Schema.Struct({ type: Schema.Literal("ack"), id: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("loaded"),
    id: Schema.Number,
    summary: Schema.Struct({
      format: Schema.Literals(["stl", "3mf", "glb"]),
      triangles: Schema.Number,
      size: Vec3,
      fingerprint: Schema.String,
    }),
    view: View,
  }),
  Schema.Struct({
    type: Schema.Literal("failed"),
    id: Schema.Number,
    code: Schema.Union([ModelPreviewError.fields.code, ZipError.fields.code]),
  }),
  Schema.Struct({ type: Schema.Literal("view"), view: View, moved: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("pick"),
    hit: Schema.Struct({ point: Vec3, normal: Vec3, face: Schema.Number }),
  }),
  Schema.Struct({ type: Schema.Literal("pin"), id: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("captured"),
    id: Schema.Number,
    requestId: Schema.Number,
    result: Schema.NullOr(
      Schema.Struct({
        screenshot: Schema.Struct({
          dataUrl: Schema.String,
          width: Schema.Number,
          height: Schema.Number,
        }),
        view: View,
      }),
    ),
  }),
]);

const decodeEvent = Schema.decodeUnknownOption(ModelViewerEventSchema);

/** A message from the page, or null for anything the page should never send. */
export function modelViewerEvent(data: string): ModelViewerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const decoded = decodeEvent(parsed);
  return decoded._tag === "Some" ? decoded.value : null;
}

/** The script native injects to run one command on the page. */
export function modelViewerInjection(command: ModelViewerCommand): string {
  return `window.t3ModelViewer&&window.t3ModelViewer.command(${JSON.stringify(command).replace(/</g, "\\u003c")});true;`;
}

/** The page's whole document: the bundled viewer script and pin styles, on the theme colour. */
export function modelViewerDocument(script: string, background: string): string {
  const safeScript = script.replace(/<\/script/gi, "<\\/script");
  const safeBackground = JSON.stringify(background).replace(/</g, "\\u003c");
  const crashed = `window.ReactNativeWebView.postMessage(JSON.stringify({type:"crashed"}));`;
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
  #viewport { position: absolute; inset: 0; overflow: hidden; }
  #pins { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
  .pin { position: absolute; left: 0; top: 0; width: 44px; height: 44px; padding: 0; border: 0; background: none; pointer-events: auto; display: flex; align-items: center; justify-content: center; }
  .pin span { box-sizing: border-box; width: 24px; height: 24px; border-radius: 12px; border: 2px solid; display: flex; align-items: center; justify-content: center; font: 700 12px/1 system-ui, sans-serif; }
</style></head><body><script>document.body.style.background=${safeBackground};window.addEventListener("error",function(){${crashed}});\n${safeScript}\ntry{window.t3ModelViewer=T3ModelViewer.start();}catch{${crashed}}</script></body></html>`;
}
