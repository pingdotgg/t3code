import { getRenderablePatch } from "~/lib/diffRendering";

self.addEventListener(
  "message",
  (event: MessageEvent<{ id: number; patch: string; scope: string }>) => {
    const { id, patch, scope } = event.data;
    self.postMessage(
      { id, patch: getRenderablePatch(patch, scope, { compactPartialHunkOffsets: true }) },
      { transfer: [] },
    );
  },
);
