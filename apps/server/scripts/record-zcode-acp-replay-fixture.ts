/**
 * Records a ZCode ACP replay transcript from a live `zcode-acp-server` bridge.
 *
 * The fixture's own scenario (the same commands and steps the replay test
 * dispatches) runs through the real orchestrator and the real ZCode adapter;
 * only the ACP runtime's protocol logger is swapped for a tee. Outbound frames
 * are therefore exactly what T3 sends, and inbound frames exactly what the
 * bridge answered. Run from apps/server with `zcode-acp-server` on PATH (or
 * T3_ZCODE_ACP_BIN) and the ZCode desktop app signed in:
 *
 *   pnpm record:zcode-replay --scenario simple
 *
 * Fixtures pick their model explicitly, so recording never runs on the
 * account's default model.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ProviderReplayEntry } from "@t3tools/contracts";
import { ZCodeSettings } from "@t3tools/provider-zcode/settings";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import { layerTestProviderHost } from "@t3tools/provider-testing/host";
import {
  makeZCodeAcpRuntime,
  makeZCodeAdapterV2,
  ZCODE_DEFAULT_INSTANCE_ID,
  ZCODE_PROVIDER,
} from "@t3tools/provider-zcode/testing";
import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/continuationRequests";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import {
  materializeFixtureInput,
  TOOL_CALL_READ_ONLY_WORKSPACE_ROOT,
} from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const HOME_PLACEHOLDER = "/home/zcode-replay";
// ZCode's own model ids; other providers configured in the recording account
// are personal and are removed from recorded model lists.
const RECORDED_MODEL_PREFIX = "builtin:zai-coding-plan\\";

interface JsonRpcMessage {
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WireMessage {
  readonly direction: "incoming" | "outgoing";
  readonly message: JsonRpcMessage;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, map));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, mapStrings(entry, map)]),
  );
}

/** Tees raw ACP lines in wire order. Replay drives one process, so a restart is an error. */
function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) {
      throw new Error("The ZCode recording spawned a second ACP process; replay drives one.");
    }
    let incomingBuffer = "";
    const push = (direction: WireMessage["direction"], line: string) => {
      if (line.trim().length === 0) return;
      wire.push({ direction, message: decodeJson(line) as JsonRpcMessage });
    };
    return {
      logIncoming: true,
      logOutgoing: true,
      logger: (event: EffectAcpProtocol.AcpProtocolLogEvent) =>
        Effect.sync(() => {
          if (event.stage !== "raw" || typeof event.payload !== "string") return;
          if (event.direction === "outgoing") {
            for (const line of event.payload.split("\n")) push("outgoing", line);
            return;
          }
          incomingBuffer += event.payload;
          const lines = incomingBuffer.split("\n");
          incomingBuffer = lines.pop() ?? "";
          for (const line of lines) push("incoming", line);
        }),
    };
  };
  return { wire, attachRuntime };
}

function frameLabel(kind: string, method: string, params: unknown): string {
  const update = isRecord(params) && isRecord(params.update) ? params.update : undefined;
  const updateType = typeof update?.sessionUpdate === "string" ? `:${update.sessionUpdate}` : "";
  return `${kind}:${method}${updateType}`;
}

/** Pairs JSON-RPC ids with their methods and emits the logical frames acp-replay-agent reads. */
function wireToEntries(wire: ReadonlyArray<WireMessage>): Array<ProviderReplayEntry> {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  for (const { direction, message } of wire) {
    const type = direction === "outgoing" ? "expect_outbound" : "emit_inbound";
    if (typeof message.method === "string") {
      const isRequest = message.id !== undefined && message.id !== null;
      if (isRequest) {
        (direction === "outgoing" ? t3Requests : agentRequests).set(
          String(message.id),
          message.method,
        );
      }
      const kind = isRequest ? "request" : "notification";
      entries.push({
        type,
        label: frameLabel(kind, message.method, message.params),
        frame: {
          kind,
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
      });
      continue;
    }
    const pending = direction === "outgoing" ? agentRequests : t3Requests;
    const method = pending.get(String(message.id));
    if (method === undefined) {
      throw new Error(`The ZCode recording saw a response to unknown request ${message.id}.`);
    }
    pending.delete(String(message.id));
    entries.push({
      type,
      label: `response:${method}`,
      frame: {
        kind: "response",
        method,
        ...(message.result === undefined ? {} : { result: message.result }),
        ...(message.error === undefined ? {} : { error: message.error }),
      },
    });
  }
  return entries;
}

const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;

/** Replaces T3-owned request content so prompt wording changes do not invalidate recordings. */
function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      // Pin the capabilities T3 advertises; the rest is <any>.
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "clientCapabilities" ? params[key] : "<any>",
          ]),
        ),
      };
    case "session/new":
    case "session/load":
    case "session/resume":
      return { ...frame, params: { ...params, mcpServers: "<any>" } };
    case "session/prompt": {
      if (!Array.isArray(params.prompt)) return frame;
      const prompt = params.prompt.filter(
        (part) => !(isRecord(part) && part.type === "text" && part.text === runtimeInstructions),
      );
      return {
        ...frame,
        params: {
          ...params,
          prompt: prompt.map((part) =>
            isRecord(part) && typeof part.text === "string"
              ? {
                  ...part,
                  text: part.text.replace(
                    T3_INSTRUCTIONS_BODY,
                    "<t3_code_instructions>\n<any>\n</t3_code_instructions>",
                  ),
                }
              : part,
          ),
        },
      };
    }
    default:
      return frame;
  }
}

/** Keeps only ZCode's own models in a recorded model selector. */
function withRecordedModels(option: unknown): unknown {
  if (!isRecord(option) || option.category !== "model" || !Array.isArray(option.options)) {
    return option;
  }
  return {
    ...option,
    options: option.options.filter(
      (entry) =>
        isRecord(entry) &&
        typeof entry.value === "string" &&
        entry.value.startsWith(RECORDED_MODEL_PREFIX),
    ),
  };
}

/**
 * Removes what belongs to the recording account rather than ZCode: models of
 * other configured providers and the user's personal skills and commands.
 */
function normalizeInboundFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(frame.params) ? frame.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  if (
    update?.sessionUpdate === "available_commands_update" &&
    Array.isArray(update.availableCommands)
  ) {
    return {
      ...frame,
      params: { ...params, update: { ...update, availableCommands: [] } },
    };
  }
  if (update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
    return {
      ...frame,
      params: {
        ...params,
        update: { ...update, configOptions: update.configOptions.map(withRecordedModels) },
      },
    };
  }
  const result = isRecord(frame.result) ? frame.result : undefined;
  if (result !== undefined && Array.isArray(result.configOptions)) {
    return {
      ...frame,
      result: { ...result, configOptions: result.configOptions.map(withRecordedModels) },
    };
  }
  return frame;
}

/** Collects ZCode session ids in first-seen order. */
function collectSessionIds(entries: ReadonlyArray<ProviderReplayEntry>): ReadonlyArray<string> {
  const ids: Array<string> = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.length > 0 && !ids.includes(value)) ids.push(value);
  };
  for (const entry of entries) {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) continue;
    const frame = entry.frame;
    if (frame.kind === "response" && frame.method === "session/new" && isRecord(frame.result)) {
      add(frame.result.sessionId);
    }
    if (entry.type === "emit_inbound" && isRecord(frame.params)) add(frame.params.sessionId);
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly tempRoot: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
}): Array<ProviderReplayEntry> {
  const sessionIds = collectSessionIds(input.entries);
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) =>
        [id, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    // Titles stream in pieces, so a partial path can stop short of the workspace.
    [input.tempRoot, "<tmp>"],
    [input.home, HOME_PLACEHOLDER],
  ];
  // Shell output (e.g. `ls -l`) names the recording user.
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  // Tool titles shorten long paths to "…<tail>", which full-path replacement misses.
  const replaceShortenedWorkspace = (text: string) => {
    if (!text.includes("…")) return text;
    for (let start = 1; start < input.workspace.length - 8; start += 1) {
      const tail = `…${input.workspace.slice(start)}`;
      if (text.includes(tail)) return text.replaceAll(tail, "<workspace>");
    }
    return text;
  };
  const replaceAll = (text: string) => {
    const replaced = replaceShortenedWorkspace(
      replacements.reduce(
        (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
        text,
      ),
    );
    return userPattern === undefined ? replaced : replaced.replace(userPattern, "zcode-replay");
  };
  return input.entries.map((entry) => {
    if (entry.type === "runtime_exit" || !isRecord(entry.frame)) return entry;
    const frame =
      entry.type === "expect_outbound"
        ? normalizeOutboundFrame(entry.frame, input.runtimeInstructions)
        : normalizeInboundFrame(entry.frame);
    return {
      ...entry,
      ...(entry.label === undefined ? {} : { label: replaceAll(entry.label) }),
      frame: mapStrings(frame, replaceAll),
    };
  });
}

const DEFAULT_ZCODE_SETTINGS = Schema.decodeUnknownSync(ZCodeSettings)({});

const recordScenario = Effect.fn("recordZCodeScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === ZCODE_PROVIDER);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No ZCode replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  if (fixtureName === "tool_call_read_only") {
    // The shared prompt names fixed paths outside the workspace; give ZCode
    // real files there so it reads rather than goes looking for them.
    yield* Effect.acquireRelease(
      Effect.gen(function* () {
        yield* fs.makeDirectory(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, { recursive: true });
        yield* fs.writeFileString(
          path.join(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, "package.json"),
          `${encodeJson({ name: "zcode-read-only-fixture", private: true })}\n`,
        );
        yield* fs.writeFileString(
          path.join(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, "tsconfig.json"),
          `${encodeJson({ compilerOptions: { target: "ES2022" } })}\n`,
        );
      }),
      () =>
        fs
          .remove(TOOL_CALL_READ_ONLY_WORKSPACE_ROOT, { recursive: true, force: true })
          .pipe(Effect.ignore),
    );
  }
  // Same README and seeded files as the replay workspace.
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: ZCODE_PROVIDER,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/zcode-record`,
    commands: materialized.commands,
    // Live, ZCode and wall time pace themselves, so a held run is simply waited for.
    steps: materialized.steps.map((step) =>
      step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
    ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const settings = {
    ...DEFAULT_ZCODE_SETTINGS,
    binaryPath: process.env.T3_ZCODE_ACP_BIN ?? "zcode-acp-server",
    zcodeBinaryPath: process.env.T3_ZCODE_BIN ?? "",
  };
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = yield* HostProcessEnvironment;
      const adapter = yield* makeZCodeAdapterV2({
        instanceId: ZCODE_DEFAULT_INSTANCE_ID,
        settings,
        environment,
        selfInvocation: yield* resolveSelfInvocation(),
        continuationRequests: yield* ProviderContinuationRequests.ProviderContinuationRequests,
        // Production's runtime factory, with the protocol logger teeing raw lines.
        makeRuntime: ({ runtimePolicy, processEnvironment, ...input }) =>
          makeZCodeAcpRuntime({
            ...input,
            protocolLogging: tee.attachRuntime(),
            zcodeSettings: settings,
            environment: { ...environment, ...processEnvironment },
            childProcessSpawner,
            runtimeMode: runtimePolicy.runtimeMode,
          }),
      });
      // The scenario runs on the replay TestClock so its clock steps order
      // dispatches as replay will. ZCode itself runs on wall time, so the
      // adapter's session does too.
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapterV2SessionRuntime => ({
                ...session,
                startTurn: (turnInput) => onWallClock(session.startTurn(turnInput)),
                steerTurn: (turnInput) => onWallClock(session.steerTurn(turnInput)),
                interruptTurn: (turnInput) => onWallClock(session.interruptTurn(turnInput)),
                respondToRuntimeRequest: (turnInput) =>
                  onWallClock(session.respondToRuntimeRequest(turnInput)),
              })),
              onWallClock,
            ),
        },
      ];
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerTestProviderHost().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  // The bridge sends the turn footer and config updates shortly after a
  // prompt resolves, so the session stays open until the wire is quiet.
  let quietPolls = 0;
  let seenFrames = -1;
  const waitForZCodeIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 3;
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("2 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForZCodeIdle }).pipe(
    Effect.provide(ProviderReplayHarness.layerWithRegistry(scenario, layerRegistry)),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const entries = wireToEntries(tee.wire);
  const closedCleanly = entries.some(
    (entry) =>
      entry.type === "expect_outbound" &&
      isRecord(entry.frame) &&
      entry.frame.method === "session/close",
  );
  const initialize = entries.find(
    (entry) =>
      entry.type === "emit_inbound" && isRecord(entry.frame) && entry.frame.method === "initialize",
  );
  const agentInfo =
    initialize?.type === "emit_inbound" &&
    isRecord(initialize.frame) &&
    isRecord(initialize.frame.result) &&
    isRecord(initialize.frame.result.agentInfo)
      ? initialize.frame.result.agentInfo
      : {};
  const transcript = {
    provider: ZCODE_PROVIDER,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-zcode-recorder",
      bridgeVersion: agentInfo.version ?? "unknown",
      model: variant.modelSelection.model,
      normalization:
        "Session ids are fixed UUIDs, the workspace is <workspace> inside <tmp>, HOME is /home/zcode-replay and the recording user is zcode-replay. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities are <any>. Advertised commands and models of providers other than ZCode's coding plan are removed. Timestamps are kept as recorded.",
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        tempRoot: path.dirname(realWorkspace),
        home: process.env.HOME ?? "",
        user: process.env.USER ?? "",
        runtimeInstructions: buildRuntimeInstructions({
          harness: "ZCode",
          model: variant.modelSelection.model,
        }),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(`Wrote ${transcriptEntries.length} ZCode ACP replay entries to ${outputPath}`);

  // The live orchestration must already satisfy the fixture's assertions;
  // replay then proves the recorded frames reproduce it.
  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    yield* Console.log(`Live orchestration failed ${fixtureName} assertions:`, liveFailure.value);
  }
});

const scenarios = readArgValues("--scenario").flatMap((value) => value.split(","));
if (scenarios.length === 0) {
  throw new Error("Pass --scenario <fixture name>[,<fixture name>...]");
}

await Effect.runPromise(
  Effect.forEach(scenarios, (name) => Effect.scoped(recordScenario(name)), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);
