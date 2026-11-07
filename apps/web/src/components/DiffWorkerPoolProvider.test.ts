import { WorkerPoolManager } from "@pierre/diffs/worker";
import { expect, it, vi } from "vite-plus/test";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { applyDiffWorkerTheme } from "./DiffWorkerPoolProvider";

const selected = vi.hoisted(() => ({ dark: "pierre-dark" }));

vi.mock("@pierre/diffs/worker/worker.js?worker", () => ({ default: vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  getDiffThemeNames: () => ({ light: "pierre-light", dark: selected.dark }),
  subscribeDiffThemeNames: () => () => {},
}));
vi.mock("../hooks/useTheme", () => ({
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));

it("keeps the latest code theme when switching back before a pending switch lands", async () => {
  // Without workers the pool still broadcasts its failed state on the next frame.
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => {
        throw new Error("No diff workers in unit tests");
      },
      poolSize: 1,
    },
    { theme: "pierre-dark", preferredHighlighter: PREFERRED_HIGHLIGHTER },
  );
  const requests: Promise<void>[] = [];
  const setRenderOptions = pool.setRenderOptions.bind(pool);
  pool.setRenderOptions = (options) => {
    const request = setRenderOptions(options);
    requests.push(request);
    return request;
  };

  for (const theme of ["dracula", "pierre-dark"]) {
    selected.dark = theme;
    applyDiffWorkerTheme(pool);
  }
  await Promise.allSettled(requests);

  expect(pool.getDiffRenderOptions().theme).toBe("pierre-dark");
  pool.terminate();
});
