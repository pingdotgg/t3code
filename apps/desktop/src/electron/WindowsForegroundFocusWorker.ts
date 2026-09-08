import * as NodeWorkerThreads from "node:worker_threads";

import type { WindowsForegroundFocusTarget } from "./WindowsForegroundFocusThread.ts";
import type { Element } from "@crowecawcaw/xa11y";

type FocusRequest = {
  readonly type: "prepare" | "focus";
  readonly requestId: number;
  readonly target: WindowsForegroundFocusTarget;
};

function matchesTarget(
  element: {
    readonly name?: string | null;
    readonly bounds: WindowsForegroundFocusTarget["bounds"] | null;
  },
  target: WindowsForegroundFocusTarget,
): boolean {
  if ((element.name ?? "").trim() !== target.title.trim()) return false;
  if (!element.bounds) return false;
  return [target.bounds, target.contentBounds].some((bounds) =>
    (["x", "y", "width", "height"] as const).every(
      (key) => Math.abs(element.bounds![key] - bounds[key]) <= 2,
    ),
  );
}

async function findTarget(
  App: (typeof import("@crowecawcaw/xa11y"))["App"],
  target: WindowsForegroundFocusTarget,
): Promise<Element | undefined> {
  const children = await App.byPid(target.processId, { timeout: 0 })
    .then((app) => app.children())
    .catch(() => []);
  return (
    children.find((candidate) => matchesTarget(candidate, target)) ??
    (await App.list())
      .filter((candidate) => candidate.pid === target.processId)
      .map((candidate) => candidate.asElement())
      .find((candidate) => matchesTarget(candidate, target))
  );
}

const cachedElements = new Map<number, Element>();

async function prepareTarget(
  App: (typeof import("@crowecawcaw/xa11y"))["App"],
  target: WindowsForegroundFocusTarget,
): Promise<boolean> {
  const element = await findTarget(App, target);
  if (!element) {
    cachedElements.delete(target.windowId);
    return false;
  }
  cachedElements.set(target.windowId, element);
  return true;
}

async function focusTarget(
  App: (typeof import("@crowecawcaw/xa11y"))["App"],
  target: WindowsForegroundFocusTarget,
): Promise<boolean> {
  let element = cachedElements.get(target.windowId);
  if (!element) {
    element = await findTarget(App, target);
    if (!element) return false;
    cachedElements.set(target.windowId, element);
  }
  try {
    await element.focus();
    return true;
  } catch {
    cachedElements.delete(target.windowId);
    return false;
  }
}

async function start() {
  const { App } = await import("@crowecawcaw/xa11y");
  const parentPort = NodeWorkerThreads.parentPort;
  if (!parentPort) return;
  let work = Promise.resolve();
  parentPort.on("message", (message: FocusRequest) => {
    if (message.type !== "prepare" && message.type !== "focus") return;
    work = work.then(async () => {
      const focused = await (
        message.type === "prepare"
          ? prepareTarget(App, message.target)
          : focusTarget(App, message.target)
      ).catch(() => false);
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
      parentPort.postMessage({ type: "result", requestId: message.requestId, focused });
    });
  });
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
  parentPort.postMessage("ready");
}

void start();
