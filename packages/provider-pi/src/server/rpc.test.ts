import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { makePiRpcConnection } from "./rpc.ts";

// A Node crash as Pi prints it, written in pieces that split a UTF-8 character and a secret.
const crashOnFirstStdinLine = `
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
  await write(${JSON.stringify(
    "    at config " +
      JSON.stringify({
        apiKey: "plain-secret-value",
        password: 'escaped-"password-tail',
        token: "escaped-\\token-tail",
      }) +
      " 'api_key': 'single-\\'quote-tail'\n",
  )});
  await write("    at postgres://u:database-password@host redis://:cache-password@host Authorization: Bearer abc.def.ghi \\u0000safe\\n");
  await write("    at fourth-frame\\n    at fifth-frame\\n\\nNode.js v22\\n");
  process.exit(1);
};
process.stdin.once("data", crash);
`;

const captureWarnings = () => {
  const warnings: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn" && Array.isArray(message)) {
      warnings.push(message);
    }
  });
  return {
    warnings,
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
  assert.notInclude(detail, "plain-secret-value");
  assert.notInclude(detail, "password-tail");
  assert.notInclude(detail, "token-tail");
  assert.notInclude(detail, "quote-tail");
  assert.notInclude(detail, "database-password");
  assert.notInclude(detail, "cache-password");
  assert.notInclude(detail, "\u0000");
  assert.notInclude(detail, "fourth-frame");
  assert.notInclude(detail, "fifth-frame");
  const lines = detail.split("\n");
  assert.lengthOf(lines, 5);
  assert.lengthOf(lines[1] ?? "", 240);
  assert.include(lines[1] ?? "", "token=[redacted]");
  for (const line of lines.slice(1)) assert.isAtMost(line.length, 240);
};

describe("PiRpc stderr diagnostics", () => {
  it.live("fails pending requests and events with Pi's redacted, bounded error", () => {
    const { warnings, layer } = captureWarnings();
    return Effect.gen(function* () {
      const { error, eventsError } = yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", crashOnFirstStdinLine],
          cwd: undefined,
          env: {},
        });
        const error = yield* connection
          .request({ type: "prompt", message: "hi" })
          .pipe(Effect.asVoid, Effect.flip);
        const eventsError = yield* Queue.take(connection.events).pipe(Effect.flip);
        return { error, eventsError };
      }).pipe(Effect.scoped);
      assert.equal(error._tag, "PiRpcError");
      assert.equal(error._tag === "PiRpcError" ? error.operation : undefined, "read");
      const detail = error._tag === "PiRpcError" ? error.detail : undefined;
      assertCrashDiagnosis(detail);
      assert.equal(eventsError.detail, detail);

      assert.lengthOf(warnings, 1);
      const [text, annotations] = warnings[0] ?? [];
      assert.equal(text, "Pi process closed stdout.");
      assert.deepEqual(annotations, { detail });
    }).pipe(Effect.provide(layer));
  });

  it.live("does not warn when the caller stops Pi", () => {
    const { warnings, layer } = captureWarnings();
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", `process.stdout.write('{"type":"ready"}\\n'); process.stdin.resume();`],
          cwd: undefined,
          env: {},
        });
        yield* Queue.take(connection.events);
        yield* connection.terminate;
        const error = yield* Queue.take(connection.events).pipe(Effect.flip);
        assert.equal(error.detail, "pi process was stopped");
      }).pipe(Effect.scoped);
      assert.isEmpty(warnings);
    }).pipe(Effect.provide(layer));
  });

  it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "does not wait on stderr a surviving child keeps open",
    () =>
      Effect.gen(function* () {
        // Detached, the grandchild survives Pi's group kill and holds stderr until the test kills it.
        const script = `
const holder = require("node:child_process").spawn(
  process.execPath,
  ["-e", "setTimeout(() => {}, 120000)"],
  { detached: true, stdio: ["ignore", "ignore", "inherit"] },
);
process.stdout.write(JSON.stringify({ type: "holder", pid: holder.pid }) + "\\n");
process.stderr.write("Error: extension failed to load\\n", () => process.exit(1));
`;
        const connection = yield* makePiRpcConnection({
          command: process.execPath,
          args: ["-e", script],
          cwd: undefined,
          env: {},
        });
        const { pid } = yield* Queue.take(connection.events);
        assert.isNumber(pid);
        yield* Effect.addFinalizer(() => Effect.sync(() => process.kill(Number(pid))));
        const error = yield* Queue.take(connection.events).pipe(Effect.flip);
        assert.equal(
          error.detail,
          "pi process exited with code 1\nError: extension failed to load",
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
