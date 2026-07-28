import * as NodeWorkerThreads from "node:worker_threads";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export type ReviewWatchEvent =
  | { readonly _tag: "Ready" }
  | { readonly _tag: "Update"; readonly path: string };

export interface ReviewWatchTarget {
  readonly path: string;
  readonly ignoredPaths: ReadonlyArray<string>;
}

type ReviewWatchWorkerMessage =
  | { readonly id: number; readonly type: "ready" }
  | { readonly id: number; readonly type: "change"; readonly path: string }
  | { readonly id: number; readonly type: "error"; readonly message: string };

const workerSource = `
const { parentPort } = require("node:worker_threads");
const { watch } = require("node:fs");
const { isAbsolute, relative, resolve } = require("node:path");

const subscriptions = new Map();
const isWithin = (candidate, root) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
};
const isIgnored = (candidate, target) =>
  target.ignoredPaths.some((ignoredPath) => isWithin(candidate, ignoredPath));
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsNativeIgnore = nodeMajor > 24 || (nodeMajor === 24 && nodeMinor >= 16);

const start = (id, targets) => {
  try {
    const watchers = targets.map((target) => {
      const ignored = (candidate) => isIgnored(resolve(target.path, candidate), target);
      const watcher = watch(target.path, {
        encoding: "utf8",
        persistent: false,
        recursive: true,
        ...(supportsNativeIgnore ? { ignore: ignored } : {}),
      }, (_event, filename) => {
        const changedPath = filename === null ? target.path : resolve(target.path, filename);
        if (!isIgnored(changedPath, target)) {
          parentPort.postMessage({ id, type: "change", path: changedPath });
        }
      });
      watcher.on("error", (error) => {
        parentPort.postMessage({ id, type: "error", message: error.message });
      });
      return watcher;
    });
    subscriptions.set(id, watchers);
    parentPort.postMessage({ id, type: "ready" });
  } catch (error) {
    parentPort.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};

const stop = (id) => {
  const watchers = subscriptions.get(id);
  subscriptions.delete(id);
  if (watchers) {
    for (const watcher of watchers) {
      watcher.close();
    }
  }
};

parentPort.on("message", (message) => {
  if (message.type === "watch") start(message.id, message.targets);
  if (message.type === "unwatch") stop(message.id);
});
`;

interface ActiveSubscription {
  readonly queue: Queue.Queue<ReviewWatchEvent, Cause.Done<void> | PlatformError.PlatformError>;
  readonly paths: string;
}

const subscriptions = new Map<number, ActiveSubscription>();
let nextSubscriptionId = 0;
let worker: NodeWorkerThreads.Worker | null = null;

const fail = (subscription: ActiveSubscription, cause: unknown) =>
  Queue.failCauseUnsafe(
    subscription.queue,
    Cause.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "watch",
        pathOrDescriptor: subscription.paths,
        cause,
      }),
    ),
  );

const getWorker = () => {
  if (worker !== null) return worker;

  const nextWorker = new NodeWorkerThreads.Worker(workerSource, { eval: true });
  nextWorker.unref();
  nextWorker.on("message", (message: ReviewWatchWorkerMessage) => {
    const subscription = subscriptions.get(message.id);
    if (!subscription) return;

    switch (message.type) {
      case "ready":
        Queue.offerUnsafe(subscription.queue, { _tag: "Ready" });
        break;
      case "change":
        Queue.offerUnsafe(subscription.queue, { _tag: "Update", path: message.path });
        break;
      case "error":
        fail(subscription, new Error(message.message));
        break;
    }
  });
  nextWorker.on("error", (cause) => {
    for (const subscription of subscriptions.values()) {
      fail(subscription, cause);
    }
  });
  nextWorker.on("exit", (code) => {
    if (worker !== nextWorker) return;
    worker = null;
    for (const subscription of subscriptions.values()) {
      fail(subscription, new Error(`Review watcher worker exited with code ${code}.`));
    }
  });
  worker = nextWorker;
  return nextWorker;
};

const watch = (targets: ReadonlyArray<ReviewWatchTarget>) =>
  Stream.callback<ReviewWatchEvent, PlatformError.PlatformError>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const id = nextSubscriptionId++;
        subscriptions.set(id, {
          queue,
          paths: targets.map((target) => target.path).join(", "),
        });
        getWorker().postMessage({ type: "watch", id, targets }, []);
        return id;
      }),
      (id) =>
        Effect.sync(() => {
          subscriptions.delete(id);
          worker?.postMessage({ type: "unwatch", id }, []);
        }),
    ),
  );

export class ReviewWatcher extends Context.Reference<{
  readonly watch: (
    targets: ReadonlyArray<ReviewWatchTarget>,
  ) => Stream.Stream<ReviewWatchEvent, PlatformError.PlatformError>;
}>("t3/review/ReviewWatcher", {
  defaultValue: () => ({ watch }),
}) {}
