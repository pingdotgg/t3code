// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import { describe, expect } from "vite-plus/test";

import * as DesktopLifetime from "./desktopLifetime.ts";

// Stands in for the desktop: spawns a backend with the lifetime pipe on fd 6,
// the way DesktopBackendManager does, then waits to be killed.
const DESKTOP_SCRIPT = `
const backend = require("node:child_process").spawn(
  process.execPath,
  ["--input-type=module", "-e", process.env.T3_TEST_BACKEND_SCRIPT],
  { stdio: ["ignore", "inherit", "inherit", "ignore", "ignore", "ignore", "pipe"] },
);
console.log("backend " + backend.pid);
setInterval(() => {}, 1 << 30);
`;

// Runs the real watcher on fd 6 and reports through the stdout it inherits
// from the desktop, which outlives the desktop.
const BACKEND_SCRIPT = `
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
const { watch } = await import(process.env.T3_TEST_DESKTOP_LIFETIME_MODULE);
const onDesktopExit = Effect.sync(() => console.log("desktop exited"));
await Effect.runPromise(Effect.scoped(Effect.flatMap(watch(6, onDesktopExit), Fiber.join)));
`;

const takeLineMatching = (lines: Queue.Dequeue<string>, matches: (line: string) => boolean) =>
  Queue.take(lines).pipe(Effect.repeat({ until: matches }));

describe("DesktopLifetime", () => {
  it.effect("reports the desktop exit when the desktop dies without cleanup", () =>
    Effect.gen(function* () {
      const lines = yield* Queue.unbounded<string>();
      const desktop = yield* Effect.acquireRelease(
        Effect.sync(() => {
          const child = NodeChildProcess.spawn(process.execPath, ["-e", DESKTOP_SCRIPT], {
            cwd: NodePath.join(import.meta.dirname, ".."),
            env: {
              ...process.env,
              T3_TEST_BACKEND_SCRIPT: BACKEND_SCRIPT,
              T3_TEST_DESKTOP_LIFETIME_MODULE: NodeURL.pathToFileURL(
                NodePath.join(import.meta.dirname, "desktopLifetime.ts"),
              ).href,
            },
            stdio: ["ignore", "pipe", "inherit"],
          });
          NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
            Queue.offerUnsafe(lines, line);
          });
          return child;
        }),
        (child) =>
          Effect.sync(() => {
            child.kill("SIGKILL");
          }),
      );
      const backendPid = Number(
        (yield* takeLineMatching(lines, (line) => line.startsWith("backend "))).slice(8),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(backendPid, "SIGKILL");
          } catch {
            // Already exited.
          }
        }),
      );

      desktop.kill("SIGKILL");
      expect(yield* takeLineMatching(lines, (line) => line === "desktop exited")).toBe(
        "desktop exited",
      );
    }),
  );

  it.effect("keeps running when the descriptor cannot be watched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-lifetime-" });
      const filePath = NodePath.join(tempDir, "not-a-pipe");
      yield* fs.writeFileString(filePath, "");
      const fd = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.openSync(filePath, "r")),
        (fd) => Effect.sync(() => NodeFS.closeSync(fd)),
      );

      const desktopExited = yield* Deferred.make<void>();
      const watcher = yield* DesktopLifetime.watch(fd, Deferred.succeed(desktopExited, undefined));
      yield* Fiber.join(watcher);

      expect(yield* Deferred.isDone(desktopExited)).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
