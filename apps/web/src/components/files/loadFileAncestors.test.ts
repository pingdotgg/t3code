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

it("bounds loads to four and finishes children even when parents finish last", async () => {
  const queue = queuedLoader();
  const loading = loadFileAncestors("a/b/c/d/e/f/file.ts", queue.load, new AbortController());
  for (let index = 3; index < 6; index++) {
    queue.resolve[index]?.();
    await Promise.resolve();
    expect(queue.paths).toHaveLength(index + 2);
  }
  expect(queue.paths).toEqual(["", "a", "a/b", "a/b/c", "a/b/c/d", "a/b/c/d/e", "a/b/c/d/e/f"]);
  for (const resolve of queue.resolve) resolve();
  await loading;
});

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
