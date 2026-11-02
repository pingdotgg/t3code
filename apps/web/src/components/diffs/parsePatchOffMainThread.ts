import { getRenderablePatch, type RenderablePatch } from "~/lib/diffRendering";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { patch: string; scope: string; resolve: (patch: RenderablePatch | null) => void }
>();

function parsePendingOnMainThread() {
  const requests = [...pending.values()];
  pending.clear();
  worker?.terminate();
  worker = null;
  for (const { patch, scope, resolve } of requests) {
    resolve(getRenderablePatch(patch, scope, { compactPartialHunkOffsets: true }));
  }
}

function parserWorker() {
  if (worker) return worker;
  const created = new Worker(new URL("./parsePatch.worker.ts", import.meta.url), {
    type: "module",
  });
  created.addEventListener(
    "message",
    (event: MessageEvent<{ id: number; patch: RenderablePatch | null }>) => {
      pending.get(event.data.id)?.resolve(event.data.patch);
      pending.delete(event.data.id);
    },
  );
  created.addEventListener("error", parsePendingOnMainThread);
  worker = created;
  return created;
}

export function parsePatchOffMainThread(patch: string, scope: string) {
  return new Promise<RenderablePatch | null>((resolve) => {
    const id = nextId++;
    pending.set(id, { patch, scope, resolve });
    try {
      parserWorker().postMessage({ id, patch, scope }, { transfer: [] });
    } catch {
      parsePendingOnMainThread();
    }
  });
}
