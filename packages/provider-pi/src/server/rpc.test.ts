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
  assert.isAtMost((lines[1] ?? "").length, 240);
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

  it.live.each([
    {
      name: "long noncredential diagnostic",
      stderr: "Error: " + "x".repeat(500),
      secret: "x".repeat(241),
      diagnosis: "Error: xxx",
    },
    {
      name: "dangling '\"' escape",
      stderr: 'Error: password="prefix secret-tail\\',
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: 'dangling "\'" escape',
      stderr: "Error: password='prefix secret-tail\\",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "authorization separator 0x2028",
      stderr: "Error: Authorization: Token prefix\u2028secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "authorization separator 0x2029",
      stderr: "Error: Authorization: Token prefix\u2029secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "Cookie remainder",
      stderr: "Error: Cookie: session=abc; other=secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "Set-Cookie remainder",
      stderr: "Error: Set-Cookie: session=abc; other=secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "encoded JSON keys",
      stderr: 'Error: body "{\\"password\\":\\"hunter2\\",\\"apiKey\\":\\"abc123\\"}"',
      secret: "hunter2",
      diagnosis: "Error:",
    },
    {
      name: "encoded API key",
      stderr: 'Error: body "{\\"apiKey\\":\\"abc123\\"}"',
      secret: "abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token ghp",
      stderr: "Error: rejected ghp_abc123",
      secret: "ghp_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token gho",
      stderr: "Error: rejected gho_abc123",
      secret: "gho_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token ghu",
      stderr: "Error: rejected ghu_abc123",
      secret: "ghu_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token ghs",
      stderr: "Error: rejected ghs_abc123",
      secret: "ghs_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token ghr",
      stderr: "Error: rejected ghr_abc123",
      secret: "ghr_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token github",
      stderr: "Error: rejected github_pat_abc123",
      secret: "github_pat_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token AIzaabc123",
      stderr: "Error: rejected AIzaabc123",
      secret: "AIzaabc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token gsk",
      stderr: "Error: rejected gsk_abc123",
      secret: "gsk_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token xai-abc123",
      stderr: "Error: rejected xai-abc123",
      secret: "xai-abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token hf",
      stderr: "Error: rejected hf_abc123",
      secret: "hf_abc123",
      diagnosis: "Error:",
    },
    {
      name: "vendor token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      stderr: "Error: rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      secret: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      diagnosis: "Error:",
    },
    {
      name: "--token space delimiter",
      stderr: "Error: failed --token abc123secret zzz999",
      secret: "abc123secret",
      diagnosis: "Error:",
    },
    {
      name: "--api-key space delimiter",
      stderr: "Error: failed --api-key abc123secret zzz999",
      secret: "abc123secret",
      diagnosis: "Error:",
    },
    {
      name: "https whitespace userinfo ' '",
      stderr: "Error: failed https://alice:prefix secret-tail@example.test/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "https whitespace userinfo '\\t'",
      stderr: "Error: failed https://alice:prefix\tsecret-tail@example.test/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "postgres whitespace userinfo ' '",
      stderr: "Error: failed postgres://alice:prefix secret-tail@example.test/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "postgres whitespace userinfo '\\t'",
      stderr: "Error: failed postgres://alice:prefix\tsecret-tail@example.test/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "credential URL path hooks.slack.com",
      stderr: "Error: failed https://hooks.slack.com/services/secret-tail",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "credential URL path api.telegram.org",
      stderr: "Error: failed https://api.telegram.org/botsecret-tail/sendMessage",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "evicted label with apparent error at retained boundary",
      stderr: 'password="Error: secret-tail' + "x".repeat(8192 - "Error: secret-tail".length),
      secret: "secret-tail",
      diagnosis: "pi process exited with code 1",
    },
    {
      name: "complete error at exact LF boundary",
      stderr:
        "discarded\nError: legitimate failure\n" +
        "x".repeat(8192 - "Error: legitimate failure\n".length),
      secret: "discarded",
      diagnosis: "Error: legitimate failure",
    },
    {
      name: "userinfo with multiple at signs",
      stderr: "Error: failed https://alice:prefix@secret-tail@example.test/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "userinfo with an apostrophe",
      stderr: "Error: failed postgres://alice:prefix'secret-tail@example.test/db",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "query on a websocket URL",
      stderr: "Error: failed wss://host/path?key=secret-tail",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "fragment on a database URL",
      stderr: "Error: failed postgres://host/db#secret-tail",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "malformed URI",
      stderr: "Error: failed https://alice:secret-tail@[invalid/path",
      secret: "secret-tail",
      diagnosis: "Error: failed",
    },
    {
      name: "unfinished password",
      stderr: 'Error: config {"password":"prefix secret-tail',
      secret: "secret-tail",
      diagnosis: "Error: config",
    },
    {
      name: "unfinished single quoted token",
      stderr: "Error: config token='prefix secret-tail",
      secret: "secret-tail",
      diagnosis: "Error: config",
    },
    {
      name: "AWS secret",
      stderr: "Error: AWS_SECRET_ACCESS_KEY=wJalr-secret-tail",
      secret: "wJalr-secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "secret key",
      stderr: "Error: secret_key=secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "private key",
      stderr: "Error: private_key=secret-tail",
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "token authorization",
      stderr: "Error: Authorization: Token opaque123",
      secret: "opaque123",
      diagnosis: "Error:",
    },
    {
      name: "digest authorization",
      stderr: 'Error: Authorization: Digest username="alice", response="secret-tail"',
      secret: "secret-tail",
      diagnosis: "Error:",
    },
    {
      name: "error after evicted credential",
      stderr:
        'Error: password="prefix' +
        "x".repeat(8300) +
        'secret-tail"\nError: legitimate failure\n    at extension.ts:1:1',
      secret: "secret-tail",
      diagnosis: "Error: legitimate failure\nat extension.ts:1:1",
    },
  ])("omits $name from crash diagnostics", ({ stderr, secret, diagnosis }) => {
    const { warnings, layer } = captureWarnings();
    return Effect.gen(function* () {
      const connection = yield* makePiRpcConnection({
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.once("data", () => process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(1)));`,
        ],
        cwd: undefined,
        env: {},
      });
      const error = yield* connection
        .request({ type: "prompt", message: "hi" })
        .pipe(Effect.asVoid, Effect.flip);
      assert.equal(error._tag, "PiRpcError");
      const detail = error._tag === "PiRpcError" ? error.detail : undefined;
      assert.isDefined(detail);
      assert.include(detail, diagnosis);
      assert.notInclude(detail, secret);
      for (const line of detail.split("\n").slice(1)) assert.isAtMost(line.length, 240);
      assert.lengthOf(warnings, 1);
      assert.deepEqual(warnings[0]?.[1], { detail });
      const eventsError = yield* Queue.take(connection.events).pipe(Effect.flip);
      assert.equal(eventsError.detail, detail);
    }).pipe(Effect.scoped, Effect.provide(layer));
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
