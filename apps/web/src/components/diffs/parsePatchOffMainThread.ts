import type { RenderablePatch } from "~/lib/diffRendering";

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<
  number,
  { resolve: (patch: RenderablePatch | null) => void; reject: (error: Error) => void }
>();

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
  created.addEventListener("error", () => {
    for (const request of pending.values()) request.reject(new Error("Could not parse the diff."));
    pending.clear();
    created.terminate();
    worker = null;
  });
  worker = created;
  return created;
}

export function parsePatchOffMainThread(patch: string, scope: string) {
  return new Promise<RenderablePatch | null>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    parserWorker().postMessage({ id, patch, scope }, { transfer: [] });
  });
}
