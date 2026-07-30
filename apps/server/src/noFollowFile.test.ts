// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  canonicalPathsMatch,
  openReadableFileNoFollow,
  openWritableFileNoFollow,
} from "./noFollowFile.ts";

describe("canonicalPathsMatch", () => {
  it("fails closed when canonical Windows path casing differs", () => {
    expect(
      canonicalPathsMatch(
        String.raw`C:\Users\Example\capture.png`,
        String.raw`C:\Users\example\CAPTURE.png`,
      ),
    ).toBe(false);
  });

  it("accepts an unchanged canonical path", () => {
    expect(canonicalPathsMatch("/Users/Example/capture.png", "/Users/Example/capture.png")).toBe(
      true,
    );
  });

  it("rejects paths that resolve to a different target", () => {
    expect(
      canonicalPathsMatch(
        String.raw`C:\Users\Example\capture.png`,
        String.raw`C:\Users\Example\outside.png`,
      ),
    ).toBe(false);
  });
});

describe("no-follow file opens", () => {
  it.effect("rejects FIFOs without waiting for a peer", () =>
    Effect.gen(function* () {
      const platform = yield* HostProcessPlatform;
      if (platform === "win32") return;
      const directory = yield* Effect.acquireRelease(
        Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-no-follow-fifo-"))),
        (directory) =>
          Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      );
      const fifoPath = NodePath.join(directory, "asset.png");
      yield* Effect.sync(() => NodeChildProcess.execFileSync("mkfifo", [fifoPath]));
      yield* Effect.promise(() =>
        expect(openReadableFileNoFollow(fifoPath, platform)).rejects.toBeDefined(),
      );
      yield* Effect.promise(() =>
        expect(openWritableFileNoFollow(fifoPath, platform)).rejects.toBeDefined(),
      );
    }),
  );
});
