import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const cursorSdkUrl = new URL("./sdk.ts", import.meta.url).href;

// Loads the real SDK in a fresh process. The send probe stops before transport.
const probeProgram = `
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const sdkRequire = createRequire(createRequire(${JSON.stringify(cursorSdkUrl)}).resolve("@cursor/sdk"));
const { proto3, ScalarType } = sdkRequire("@bufbuild/protobuf");
const mode = process.argv[1];
if (mode === "sdk-model-requests") {
  process.on("uncaughtException", error => {
    console.error(error.stack);
    process.exit(1);
  });
}
const dir = mkdtempSync(join(tmpdir(), "cursor-sdk-model-"));
const { createAgentPlatform } = await import(${JSON.stringify(cursorSdkUrl)});

if (mode === "sdk-model-requests") {
  const { JsonlLocalAgentStore } = sdkRequire("@cursor/sdk");
  const store = new JsonlLocalAgentStore(join(dir, "store"));
  const platform = await createAgentPlatform({ localStore: store, workspaceRef: dir });
  // Catalog validation is an external dependency; the SDK's send path and
  // generated RequestedModel constructor stay real. Stop before transport.
  platform.resolveLocalModelSelection = async selection => selection;
  globalThis.fetch = async () => { throw new Error("Unexpected network request"); };
  const requests = [];
  const initPartial = proto3.util.initPartial;
  const captured = new Error("model request captured before transport");
  proto3.util.initPartial = function(source, target) {
    initPartial.call(this, source, target);
    if (target.getType().typeName !== "agent.v1.RequestedModel" || !target.modelId) return;
    const decoded = target.getType().fromBinary(target.toBinary());
    requests.push({ model: decoded.modelId, maxMode: decoded.maxMode,
      context: decoded.parameters.find(parameter => parameter.id === "context")?.value });
    throw captured;
  };
  for (const [id, context] of [
    ["grok-4.7", "500k"], ["grok-4.7", "256k"],
    ["claude-opus-5-5", "1m"], ["claude-opus-5-5", "300k"],
  ]) {
    const agent = await platform.createAgent({
      apiKey: "t3-offline-test-key", model: { id, params: [{ id: "context", value: context }] },
      mode: "plan", tools: [], local: { cwd: dir, store, autoReview: false,
        settingSources: [], sandboxOptions: { enabled: false }, enableAgentRetries: false },
    });
    try {
      await agent.send("Reply with exactly: pong");
      throw new Error("SDK did not construct a model request");
    } catch (error) {
      if (error !== captured && error.cause !== captured) throw error;
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  }
  console.log(JSON.stringify(requests));
  process.exit(0);
}

if (mode === "model-requests") {
  const Parameter = proto3.makeMessageType("agent.v1.ModelParameter", [
    { no: 1, name: "id", kind: "scalar", T: ScalarType.STRING },
    { no: 2, name: "value", kind: "scalar", T: ScalarType.STRING },
  ]);
  const fields = [
    { no: 1, name: "model_id", kind: "scalar", T: ScalarType.STRING },
    { no: 2, name: "max_mode", kind: "scalar", T: ScalarType.BOOL },
    { no: 3, name: "parameters", kind: "message", T: Parameter, repeated: true },
  ];
  const RequestedModel = proto3.makeMessageType("agent.v1.RequestedModel", fields);
  const OtherMessage = proto3.makeMessageType("other.RequestedModel", fields);
  const cases = [
    { modelId: "claude-opus-5-5", context: "1m" },
    { modelId: "grok-4.7", context: "500k" },
    { modelId: "gpt-5.6-sol", context: "1M" },
    { modelId: "claude-opus-5-5", context: "0.5m" },
    { modelId: "claude-opus-5-5", context: "300k" },
    { modelId: "grok-4.7", context: "256k" },
    { modelId: "gpt-5.6-sol", context: "272k" },
    { modelId: "claude-sonnet-4-6", context: "200k" },
    { modelId: "claude-opus-5-5", context: "0.3m" },
    { modelId: "default" },
    { modelId: "custom", context: "unknown" },
    { modelId: "claude-opus-5-5", context: "300k", maxMode: true },
  ];
  const requests = cases.map(({ context, ...selection }) => {
    const source = {
      ...selection,
      parameters: [
        { id: "reasoning_effort", value: "high" },
        ...(context === undefined ? [] : [{ id: "context", value: context }]),
        { id: "fast", value: "true" },
      ],
    };
    const sourceBefore = JSON.stringify(source);
    const request = new RequestedModel(source);
    const decoded = RequestedModel.fromBinary(request.toBinary());
    return {
      maxMode: decoded.maxMode,
      modelId: decoded.modelId,
      parameters: decoded.parameters.map(({ id, value }) => ({ id, value })),
      sourceUnchanged: sourceBefore === JSON.stringify(source),
    };
  });
  const unrelated = new OtherMessage({ parameters: [{ id: "context", value: "1m" }] });
  console.log(JSON.stringify({ requests, unrelatedMaxMode: unrelated.maxMode }));
  process.exit(0);
}

console.error("Unknown Cursor SDK model probe: " + mode);
process.exit(2);
`;

const runProbe = Effect.fnUntraced(
  function* (mode: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        HostProcess.ExecutablePath.defaultValue(),
        [
          "--experimental-strip-types",
          "--disable-warning=ExperimentalWarning",
          "--input-type=module",
          "-e",
          probeProgram,
          mode,
        ],
        { stdin: "ignore" },
      ),
    );
    return yield* Effect.all(
      {
        code: child.exitCode,
        stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
        stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      },
      { concurrency: "unbounded" },
    );
  },
  Effect.scoped,
  Effect.timeout("5 seconds"),
  Effect.provide(NodeServices.layer),
);

describe("Cursor long-context requests", () => {
  it.live("sets Max Mode in real SDK sends for the reported context tiers", () =>
    Effect.gen(function* () {
      const result = yield* runProbe("sdk-model-requests");
      expect(result.code, result.stderr.slice(-2_000)).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        { model: "grok-4.7", context: "500k", maxMode: true },
        { model: "grok-4.7", context: "256k", maxMode: false },
        { model: "claude-opus-5-5", context: "1m", maxMode: true },
        { model: "claude-opus-5-5", context: "300k", maxMode: false },
      ]);
    }),
  );

  it.live("serializes Max Mode for long tiers and preserves standard requests", () =>
    Effect.gen(function* () {
      const result = yield* runProbe("model-requests");
      expect(result.code).toBe(0);
      const { requests, unrelatedMaxMode } = JSON.parse(result.stdout);
      expect(requests.map((request: { maxMode: boolean }) => request.maxMode)).toEqual([
        true,
        true,
        true,
        true,
        false,
        false,
        false,
        false,
        false,
        false,
        false,
        true,
      ]);
      expect(requests[0]).toEqual({
        maxMode: true,
        modelId: "claude-opus-5-5",
        parameters: [
          { id: "reasoning_effort", value: "high" },
          { id: "context", value: "1m" },
          { id: "fast", value: "true" },
        ],
        sourceUnchanged: true,
      });
      expect(
        requests.every((request: { sourceUnchanged: boolean }) => request.sourceUnchanged),
      ).toBe(true);
      expect(unrelatedMaxMode).toBe(false);
    }),
  );
});
