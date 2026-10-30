/**
 * Records an fx ACP replay transcript through the real orchestrator and
 * FxAdapterV2, teeing only the protocol logger. Run from apps/server with
 * fx 0.0.13 on PATH (or T3_FX_BIN); HOME stays the user's real login:
 *   node scripts/record-fx-acp-replay-fixture.ts --scenario simple
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, type ProviderReplayEntry } from "@t3tools/contracts";
import { FxSettings } from "@t3tools/provider-fx/settings";
import { FX_DRIVER_KIND, makeFxAcpRuntime, makeFxAdapterV2 } from "@t3tools/provider-fx/testing";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as EffectAcpProtocol from "effect-acp/protocol";

import { ACP_PROTOCOL } from "@t3tools/provider-acp/server/adapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapterRegistry from "../src/orchestration-v2/ProviderAdapterRegistry.ts";
import { provideDeterministicTestRuntime } from "../src/orchestration-v2/testkit/DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";
import { materializeFixtureInput } from "../src/orchestration-v2/testkit/fixtures/shared.ts";
import { runOrchestratorV2Scenario } from "../src/orchestration-v2/testkit/OrchestratorScenario.ts";
import * as ProviderReplayHarness from "../src/orchestration-v2/testkit/ProviderReplayHarness.ts";

const wallClock = Clock.Clock.defaultValue();
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const HOME_PLACEHOLDER = "/home/fx-replay";
const FX_INSTANCE_ID = ProviderInstanceId.make("fx");
const T3_INSTRUCTIONS_BODY = /<t3_code_instructions>\n[\s\S]*?\n<\/t3_code_instructions>/u;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu;
const TOKEN = /\b(?:sk-|gho_|ghp_|xai-|vercel_)[A-Za-z0-9_-]{8,}\b/gu;

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

const readUserSkillNames = Effect.fn("readFxUserSkillNames")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(path.join(home, ".fx", "skills"))
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  return entries
    .filter((name) => name.length > 0)
    .toSorted((left, right) => right.length - left.length);
});

/** Tees raw ACP lines in wire order. Replay drives one process, so a restart is an error. */
function makeWireTee() {
  const wire: Array<WireMessage> = [];
  let runtimeCount = 0;
  const attachRuntime = () => {
    runtimeCount += 1;
    if (runtimeCount > 1) {
      throw new Error("The fx recording spawned a second ACP process; replay drives one.");
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

function wireToEntries(wire: ReadonlyArray<WireMessage>): {
  readonly entries: Array<ProviderReplayEntry>;
  readonly droppedFrames: number;
} {
  const entries: Array<ProviderReplayEntry> = [];
  const t3Requests = new Map<string, string>();
  const agentRequests = new Map<string, string>();
  let droppedFrames = 0;
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
      droppedFrames += 1;
      continue;
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
  return { entries, droppedFrames };
}

/** Replaces T3-owned request content. User prompt text, clientCapabilities, and _meta stay. */
function normalizeOutboundFrame(frame: Record<string, unknown>, runtimeInstructions: string) {
  const params = isRecord(frame.params) ? frame.params : undefined;
  if (params === undefined) return frame;
  switch (frame.method) {
    case "initialize":
      return {
        ...frame,
        params: Object.fromEntries(
          Object.keys(params).map((key) => [
            key,
            key === "protocolVersion" || key === "clientCapabilities" || key === "_meta"
              ? params[key]
              : "<any>",
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

function normalizeInboundFrame(frame: Record<string, unknown>): Record<string, unknown> {
  const params = isRecord(frame.params) ? frame.params : undefined;
  const update = isRecord(params?.update) ? params.update : undefined;
  if (
    update?.sessionUpdate === "available_commands_update" &&
    Array.isArray(update.availableCommands)
  ) {
    return {
      ...frame,
      params: {
        ...params,
        update: {
          ...update,
          availableCommands: update.availableCommands.filter(
            (command) =>
              !(isRecord(command) && isRecord(command._meta) && command._meta.scope === "user"),
          ),
        },
      },
    };
  }
  return frame;
}

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
    if (entry.type === "emit_inbound" && isRecord(frame.params)) {
      add(frame.params.sessionId);
    }
  }
  return ids;
}

function normalizeEntries(input: {
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
  readonly workspace: string;
  readonly home: string;
  readonly user: string;
  readonly runtimeInstructions: string;
  readonly skillNames: ReadonlyArray<string>;
  readonly gatewayApiKey?: string;
}): Array<ProviderReplayEntry> {
  const sessionIds = collectSessionIds(input.entries);
  const replacements: Array<readonly [string, string]> = [
    ...sessionIds.map(
      (id, index) => [id, `fx-session-${String(index + 1).padStart(2, "0")}`] as const,
    ),
    [input.workspace, "<workspace>"],
    [encodeURIComponent(input.workspace), "%3Cworkspace%3E"],
    [input.home, HOME_PLACEHOLDER],
    ...input.skillNames.flatMap((name, index) => {
      const token = `skill-${index + 1}`;
      return [
        [`$${name}`, `$${token}`],
        [`/skills/${name}/`, `/skills/${token}/`],
        [`/skills/${name}`, `/skills/${token}`],
      ] as const;
    }),
  ];
  const user = /^[a-z_][a-z0-9_-]*$/iu.test(input.user) ? input.user : "";
  const userPattern = user.length === 0 ? undefined : new RegExp(`\\b${user}\\b`, "gu");
  const gatewayApiKey = input.gatewayApiKey ?? "";
  const replaceAll = (text: string) => {
    const withoutGatewayKey =
      gatewayApiKey.length === 0 ? text : text.replaceAll(gatewayApiKey, "<token>");
    const replaced = replacements.reduce(
      (current, [from, to]) => (from.length === 0 ? current : current.replaceAll(from, to)),
      withoutGatewayKey,
    );
    const withoutUser =
      userPattern === undefined ? replaced : replaced.replace(userPattern, "fx-replay");
    return withoutUser.replace(EMAIL, "user@fx-replay.example").replace(TOKEN, "<token>");
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

const DEFAULT_FX_SETTINGS = Schema.decodeSync(FxSettings)({});

const recordScenario = Effect.fn("recordFxScenario")(function* (fixtureName: string) {
  const fixture = ORCHESTRATOR_REPLAY_FIXTURES.find((candidate) => candidate.name === fixtureName);
  const variant = fixture?.providers.find((provider) => provider.driver === FX_DRIVER_KIND);
  if (fixture === undefined || variant === undefined) {
    return yield* Effect.die(new Error(`No fx replay fixture named '${fixtureName}'.`));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fixtureInput = fixture.buildInput();
  const workspace = yield* checkpointWorkspace(fixtureName, fixtureInput.workspaceFiles);
  const realWorkspace = yield* fs.realPath(workspace);
  const materialized = yield* materializeFixtureInput({
    scenario: fixtureName,
    fixtureInput,
    driver: FX_DRIVER_KIND,
    modelSelection: variant.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${fixtureName}/fx-record`,
    commands: materialized.commands,
    steps: materialized.steps.some(
      (step) =>
        step.type === "release_replay_gate" || step.type === "release_replay_gate_after_waiting",
    )
      ? materialized.steps.filter(
          (step) =>
            step.type !== "release_replay_gate" &&
            step.type !== "release_replay_gate_after_waiting",
        )
      : materialized.steps.map((step) =>
          step.type === "finish_held_run" ? { ...step, type: "await_run_status" as const } : step,
        ),
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: { ...variant.runtimePolicyOverride, cwd: realWorkspace },
  };

  const tee = makeWireTee();
  const settings = { ...DEFAULT_FX_SETTINGS, binaryPath: process.env.T3_FX_BIN ?? "fx" };
  const layerRegistry = ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const environment = yield* HostProcess.Environment;
      const adapter = yield* makeFxAdapterV2({
        instanceId: FX_INSTANCE_ID,
        settings,
        environment,
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          makeFxAcpRuntime({
            ...input,
            protocolLogging: tee.attachRuntime(),
            fxSettings: settings,
            environment,
          }),
      });
      const onWallClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, Clock.Clock, wallClock);
      return [
        {
          ...adapter,
          openSession: (input) =>
            adapter.openSession(input).pipe(
              Effect.map((session): ProviderAdapter.ProviderAdapterV2SessionRuntime => ({
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
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
        NodeServices.layer,
        IdAllocator.layer,
      ),
    ),
  );

  let quietPolls = 0;
  let seenFrames = -1;
  const waitForFxIdle = Effect.sleep("1 second").pipe(
    Effect.andThen(
      Effect.sync(() => {
        quietPolls = seenFrames === tee.wire.length ? quietPolls + 1 : 0;
        seenFrames = tee.wire.length;
        return quietPolls >= 5;
      }),
    ),
    Effect.repeat({ until: (idle) => idle }),
    Effect.timeout("5 minutes"),
    Effect.orDie,
    Effect.asVoid,
    Effect.provideService(Clock.Clock, wallClock),
  );
  const result = yield* runOrchestratorV2Scenario(scenario, { afterSteps: waitForFxIdle }).pipe(
    Effect.provide(
      ProviderReplayHarness.layerWithRegistry(
        scenario,
        layerRegistry,
        variant.runContinuationWorker === true ? { runContinuationWorker: true } : {},
      ),
    ),
    provideDeterministicTestRuntime,
    Effect.scoped,
  );

  const { entries, droppedFrames } = wireToEntries(tee.wire);
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
  const initializeAgent =
    initialize?.type === "emit_inbound" &&
    isRecord(initialize.frame) &&
    isRecord(initialize.frame.result) &&
    isRecord(initialize.frame.result.agentInfo)
      ? initialize.frame.result.agentInfo
      : {};
  const home = process.env.HOME ?? "";
  const transcript = {
    provider: FX_DRIVER_KIND,
    protocol: ACP_PROTOCOL,
    version: "1",
    scenario: fixtureName,
    metadata: {
      generatedBy: "live-fx-recorder",
      fxVersion: initializeAgent.version ?? "unknown",
      normalization:
        "Session ids are fx-session-NN, the workspace is <workspace>, HOME is /home/fx-replay and the recording user is fx-replay. T3-owned prompt text, MCP servers and initialize params other than clientCapabilities and _meta are <any>. User skill names, emails and token-shaped strings are removed. Timestamps are kept as recorded.",
      droppedFrames,
    },
    entries: [
      ...normalizeEntries({
        entries,
        workspace: realWorkspace,
        home,
        user: process.env.USER ?? "",
        skillNames: yield* readUserSkillNames(home),
        ...(process.env.AI_GATEWAY_API_KEY === undefined
          ? {}
          : { gatewayApiKey: process.env.AI_GATEWAY_API_KEY }),
        runtimeInstructions: buildRuntimeInstructions({
          harness: "fx",
          model: variant.modelSelection.model,
        }),
      }),
      { type: "runtime_exit", status: closedCleanly ? "success" : "cancelled" } as const,
    ],
  };

  const outputPath = readArgValues("--out")[0] ?? (yield* path.fromFileUrl(variant.transcriptFile));
  const liveFailure = yield* Effect.try(() => variant.assertOutput(result, transcript)).pipe(
    Effect.flip,
    Effect.option,
  );
  if (liveFailure._tag === "Some") {
    const dumpPath = path.join(
      process.env.TMPDIR ?? "/tmp",
      `fx-replay-${fixtureName}-failed.json`,
    );
    yield* fs.writeFileString(dumpPath, encodeJson(transcript));
    yield* Console.log(
      `Live orchestration failed ${fixtureName} assertions; left ${outputPath} unchanged. Dump: ${dumpPath}`,
      liveFailure.value,
    );
    return yield* Effect.die(liveFailure.value);
  }

  const { entries: transcriptEntries, ...header } = transcript;
  yield* fs.writeFileString(
    outputPath,
    [
      encodeJson({ type: "transcript_start", ...header }),
      ...transcriptEntries.map((entry) => encodeJson(entry)),
      "",
    ].join("\n"),
  );
  yield* Console.log(`Wrote ${transcriptEntries.length} fx ACP replay entries to ${outputPath}`);
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
