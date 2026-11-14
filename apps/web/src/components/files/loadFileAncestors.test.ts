import { expect, it } from "vite-plus/test";
import { loadFileAncestors } from "./loadFileAncestors";

function queuedLoader() {
  const paths: string[] = [];
  const resolve: Array<() => void> = [];
  const load = (path: string) => {
    paths.push(path);
    return new Promise<void>((done) => resolve.push(done));
  };
  return { paths, resolve, load };
}

it("stops aborted reveals while a new selection loads independently", async () => {
  const old = queuedLoader();
  const controller = new AbortController();
  const oldReveal = loadFileAncestors("old/a/b/c/d/file.ts", old.load, controller);
  controller.abort();
  const fresh = queuedLoader();
  const newReveal = loadFileAncestors("new/file.ts", fresh.load, new AbortController());
  for (const resolve of [...old.resolve, ...fresh.resolve]) resolve();
  await Promise.all([oldReveal, newReveal]);
  await loadFileAncestors("aborted/path/file.ts", old.load, controller);
  expect(old.paths).toEqual(["", "old", "old/a", "old/a/b"]);
  expect(fresh.paths).toEqual(["", "new"]);
});
