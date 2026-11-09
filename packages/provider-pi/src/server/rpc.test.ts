import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makePiRpcConnection } from "./rpc.ts";

// A Node crash as Pi prints it, written in pieces that split a UTF-8 character and a secret.
const crashOnFirstStdinLine = (waitForStdin: boolean) => `
const write = (chunk) => new Promise((resolve) => process.stderr.write(chunk, resolve));
const crash = async () => {
  await write("user prompt: summarize my private plan\\n");
  const error = Buffer.from(
    "Error: This extension ctx is stale after session replacement (café) token=sk-abcdefghijklmnopqrstuvwxyz " +
      "x".repeat(2000) + "\\n",
  );
  const accent = error.indexOf("é") + 1;
  const secret = error.indexOf("sk-") + 6;
  await write(error.subarray(0, accent));
  await write(error.subarray(accent, secret));
  await write(error.subarray(secret));
  await write("    at Object.<anonymous> (/ext/mitsupi/extensions/prompt-editor.ts:1184:7)\\n");
  await write("    at Authorization: Bearer abc.def.ghi\\n\\nNode.js v22\\n");
  process.exit(1);
};
${waitForStdin ? 'process.stdin.once("data", crash);' : "crash();"}
`;

const captureWarnings = () => {
  const warnings: Array<ReadonlyArray<unknown>> = [];
  const warned = Deferred.makeUnsafe<void>();
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn" && Array.isArray(message)) {
      warnings.push(message);
      Deferred.doneUnsafe(warned, Effect.void);
    }
  });
  return {
    warnings,
    warned,
    layer: Layer.merge(NodeServices.layer, Logger.layer([logger], { mergeWithExisting: false })),
  };
};

const assertCrashDiagnosis = (detail: string | undefined) => {
  assert.isDefined(detail);
  assert.isTrue(detail.startsWith("pi process exited with code 1\n"));
  assert.include(detail, "Error: This extension ctx is stale after session replacement (café)");
  assert.include(detail, "at Object.<anonymous> (/ext/mitsupi/extensions/prompt-editor.ts:1184:7)");
  assert.notInclude(detail, "sk-abcdefghijklmnopqrstuvwxyz");
  assert.notInclude(detail, "abc.def.ghi");
  assert.notInclude(detail, "private plan");
  assert.notInclude(detail, "Node.js");
  assert.isAtMost(detail.length, 1_100);
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("PiRpc stderr diagnostics", () => {
  it.live("explains a startup crash with Pi's redacted, bounded error", () => {
    const { warnings, warned, layer } = captureWarnings();
    return Effect.gen(function* () {
      const connection = yield* makePiRpcConnection({
        command: process.execPath,
        args: ["-e", crashOnFirstStdinLine(false)],
        cwd: undefined,
        env: {},
      });
      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error.operation, "read");
      assertCrashDiagnosis(error.detail);

      yield* Deferred.await(warned);
      assert.lengthOf(warnings, 1);
      const [text, annotations] = warnings[0] ?? [];
      assert.equal(text, "Pi process closed stdout.");
      assert.deepEqual(annotations, { detail: error.detail });
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.live("fails a pending request with the crash diagnosis", () =>
    Effect.gen(function* () {
      const connection = yield* makePiRpcConnection({
        command: process.execPath,
        args: ["-e", crashOnFirstStdinLine(true)],
        cwd: undefined,
        env: {},
      });
      const error = yield* connection
        .request({ type: "prompt", message: "hi" })
        .pipe(Effect.asVoid, Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      assertCrashDiagnosis(error._tag === "PiRpcError" ? error.detail : undefined);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does not wait on stderr a surviving child keeps open", () =>
    Effect.gen(function* () {
      // The grandchild holds only stderr, then exits on its own so the test leaks nothing.
      const script = `
require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], {
  stdio: ["ignore", "ignore", "inherit"],
});
process.stderr.write("Error: extension failed to load\\n", () => process.exit(1));
`;
      const connection = yield* makePiRpcConnection({
        command: process.execPath,
        args: ["-e", script],
        cwd: undefined,
        env: {},
      });
      const error = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(error.detail, "pi process exited with code 1\nError: extension failed to load");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
