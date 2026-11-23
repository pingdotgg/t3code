// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { createPipe, pipesSupportedOn, servePipeOnce } from "./secretPipe.ts";

/** Runs `body` with a fresh temp directory, on platforms that have named pipes. */
const withPipeDir = (body: (directory: string) => Promise<void>) =>
  Effect.gen(function* () {
    if (!pipesSupportedOn(yield* HostProcess.Platform)) return;
    yield* Effect.acquireUseRelease(
      Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "secret-pipe-test-"))),
      (directory) => Effect.promise(() => body(directory)),
      (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
  });

it.effect("a pipe gives the value to the first reader only, then is removed and zeroed", () =>
  withPipeDir(async (directory) => {
    const pipe = NodePath.join(directory, "pipe");
    await createPipe(pipe);
    const stat = NodeFS.lstatSync(pipe);
    assert.isTrue(stat.isFIFO());
    assert.equal(stat.mode & 0o777, 0o600);
    const value = new TextEncoder().encode("pa ss'$(id)\n");
    const served = servePipeOnce(pipe, value, { windowMs: 5_000, pollMs: 10 });
    assert.equal(await NodeFS.promises.readFile(pipe, "utf8"), "pa ss'$(id)\n");
    assert.isTrue(await served);
    assert.isFalse(NodeFS.existsSync(pipe));
    assert.isTrue(value.every((byte) => byte === 0));
  }),
);

it.effect("an unread pipe is removed when its window ends", () =>
  withPipeDir(async (directory) => {
    const pipe = NodePath.join(directory, "pipe");
    await createPipe(pipe);
    const value = new TextEncoder().encode("unread");
    assert.isFalse(await servePipeOnce(pipe, value, { windowMs: 50, pollMs: 10 }));
    assert.isFalse(NodeFS.existsSync(pipe));
    assert.isTrue(value.every((byte) => byte === 0));
  }),
);

it.effect("a pipe stops serving when aborted", () =>
  withPipeDir(async (directory) => {
    const pipe = NodePath.join(directory, "pipe");
    await createPipe(pipe);
    const controller = new AbortController();
    const served = servePipeOnce(pipe, new TextEncoder().encode("x"), {
      windowMs: 5_000,
      pollMs: 10,
      signal: controller.signal,
    });
    controller.abort();
    assert.isFalse(await served);
    assert.isFalse(NodeFS.existsSync(pipe));
  }),
);

it.effect("a regular file put where the pipe was is never written to", () =>
  withPipeDir(async (directory) => {
    const path = NodePath.join(directory, "pipe");
    NodeFS.writeFileSync(path, "");
    assert.isFalse(await servePipeOnce(path, new TextEncoder().encode("x"), { windowMs: 200 }));
    assert.isFalse(NodeFS.existsSync(path));
  }),
);
