import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  CliRpcError,
  isDefinitiveCommandRejectionError,
  isDefinitiveCommandRejectionResponse,
  resolveLiveTarget,
  wsRpcProtocolLayer,
} from "./client.ts";

it.effect("provides a Node WebSocket constructor for the CLI RPC protocol", () =>
  Effect.scoped(
    Layer.build(wsRpcProtocolLayer("ws://127.0.0.1:3100/ws")).pipe(
      Effect.tap(() => Effect.sync(() => assert.isTrue(true))),
    ),
  ),
);

it("only classifies structured invariant responses as definitive command rejections", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "invariant failed", code: "command-rejected" }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionResponse(
      JSON.stringify({ error: "storage failed", code: "dispatch-failed" }),
    ),
  );
  assert.isFalse(isDefinitiveCommandRejectionResponse("<html>server unavailable</html>"));
});

it("preserves definitive command rejection as structured CLI error state", () => {
  assert.isTrue(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "dispatch rejected",
        definitiveCommandRejection: true,
      }),
    ),
  );
  assert.isFalse(
    isDefinitiveCommandRejectionError(
      new CliRpcError({
        message: "ORCHESTRATION_COMMAND_REJECTED: appears only in diagnostics",
      }),
    ),
  );
});

it("reports malformed persisted runtime state with actionable recovery", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-invalid-runtime-state-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(runtimeStatePath, "not-json\n", "utf8");

    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, runtimeStatePath);
    assert.include(error.message, "Remove it and restart T3");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("uses T3CODE_HOME for live commands when --base-dir is omitted", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-env-home-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  const previousHome = process.env.T3CODE_HOME;
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        port: 45_678,
        origin: "http://127.0.0.1:45678",
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
    process.env.T3CODE_HOME = baseDir;

    const target = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.none(),
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    assert.equal(target.baseDir, baseDir);
    assert.equal(target.origin, "http://127.0.0.1:45678");
  } finally {
    if (previousHome === undefined) {
      delete process.env.T3CODE_HOME;
    } else {
      process.env.T3CODE_HOME = previousHome;
    }
    await rm(baseDir, { recursive: true, force: true });
  }
});

it("rejects persisted runtime state owned by a stopped process", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "t3-cli-stale-runtime-state-"));
  const runtimeStatePath = join(baseDir, "userdata", "server-runtime.json");
  try {
    await mkdir(join(baseDir, "userdata"), { recursive: true });
    await writeFile(
      runtimeStatePath,
      `${JSON.stringify({
        version: 1,
        pid: 4_194_305,
        port: 3_773,
        origin: "http://127.0.0.1:3773",
        startedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const error = await Effect.runPromise(
      resolveLiveTarget({
        url: Option.none(),
        token: Option.none(),
        baseDir: Option.some(baseDir),
      }).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
    );

    assert.include(error.message, "stopped process");
    assert.include(error.message, runtimeStatePath);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
