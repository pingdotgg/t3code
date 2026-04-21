import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, FileSystem, Path, PlatformError } from "effect";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import * as CodexClient from "../../src/client.ts";
import type * as CodexRpc from "../../src/_generated/meta.gen.ts";

const DEFAULT_OUT_DIR = "test/fixtures/codex-app-server-probes";
const SIMPLE_PROMPT = "Respond with the following text: fixture simple ok";
const TOOL_CALL_WRITE_PROMPT =
  "Create or overwrite .codex-probe-write-action.txt with exactly this text: codex app-server approval fixture. Use a local shell command or file edit only, then briefly report what happened. Do not read package metadata, use GitHub, use web, or use MCP.";
const SUBAGENT_PROMPT = "Spawn 2 subagents, one to read package.json and one to read tsconfig.json";
const TURN_INTERRUPT_PROMPT =
  "Do not answer immediately. First run the local shell command `sleep 30`, then respond with exactly: interrupt fixture should not finish naturally.";

const SCENARIO_NAMES = [
  "simple",
  "tool_call_read_only_on_request",
  "tool_call_workspace_never",
  "tool_call_restricted_granular",
  "subagent",
  "multi_turn",
  "message_steering",
  "turn_interrupt",
  "thread_rollback",
] as const;

type ScenarioName = (typeof SCENARIO_NAMES)[number];
type TurnStartParams = CodexRpc.ClientRequestParamsByMethod["turn/start"];
type TurnStartInput = TurnStartParams["input"];
type TurnStartResponse = CodexRpc.ClientRequestResponsesByMethod["turn/start"];
type SandboxPolicy = NonNullable<TurnStartParams["sandboxPolicy"]>;
type ApprovalPolicy = NonNullable<TurnStartParams["approvalPolicy"]>;

interface ProbeRun {
  readonly name: string;
  readonly prompt?: string;
  readonly description: string;
  readonly steps: ReadonlyArray<ProbeStep>;
  readonly turnDefaults?: Omit<TurnStartParams, "input" | "threadId">;
}

type ProbeStep =
  | {
      readonly type: "turn";
      readonly label: string;
      readonly prompt: string;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "steeredTurn";
      readonly label: string;
      readonly prompt: string;
      readonly steer: string;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "interruptedTurn";
      readonly label: string;
      readonly prompt: string;
      readonly interruptAfterMs: number;
      readonly turnOverrides?: Omit<TurnStartParams, "input" | "threadId">;
    }
  | {
      readonly type: "rollback";
      readonly label: string;
      readonly numTurns: number;
    };

interface ProbeScenario {
  readonly name: ScenarioName;
  readonly fileName: `${ScenarioName}.ndjson`;
  readonly description: string;
  readonly runs: ReadonlyArray<ProbeRun>;
}

interface Recorder {
  readonly path: string;
  readonly setVersion: (version: string) => Effect.Effect<void>;
  readonly writeRecord: (
    record: Record<string, unknown>,
  ) => Effect.Effect<void, PlatformError.PlatformError>;
  readonly flush: () => Effect.Effect<void, PlatformError.PlatformError>;
}

function readArgValue(name: string): string | undefined {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readArgValues(name: string): ReadonlyArray<string> {
  const args = process.argv.slice(2);
  return args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]!] : []));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseScenarios(): ReadonlyArray<ScenarioName> {
  const rawValues = [
    ...readArgValues("--scenario"),
    ...(process.env.CODEX_PROBE_SCENARIOS ? [process.env.CODEX_PROBE_SCENARIOS] : []),
  ];
  const requested = rawValues.length > 0 ? rawValues : ["all"];
  const names = requested.flatMap((value) =>
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  );

  if (names.includes("all")) {
    return SCENARIO_NAMES;
  }

  const expandedNames = names.flatMap((name) =>
    name === "tool_call"
      ? [
          "tool_call_read_only_on_request",
          "tool_call_workspace_never",
          "tool_call_restricted_granular",
        ]
      : [name],
  );

  const invalid = expandedNames.filter(
    (name): name is string => !SCENARIO_NAMES.includes(name as ScenarioName),
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown scenario(s): ${invalid.join(", ")}`);
  }

  return [...new Set(expandedNames)] as ReadonlyArray<ScenarioName>;
}

function classifyJsonRpcPayload(payload: unknown): string {
  if (!isRecord(payload)) {
    return "unknown";
  }
  if (typeof payload.method === "string" && "id" in payload) {
    return "request";
  }
  if (typeof payload.method === "string") {
    return "notification";
  }
  if ("id" in payload && "error" in payload) {
    return "error_response";
  }
  if ("id" in payload && "result" in payload) {
    return "response";
  }
  return "unknown";
}

function protocolMethod(payload: unknown): string | undefined {
  return isRecord(payload) && typeof payload.method === "string" ? payload.method : undefined;
}

function protocolId(payload: unknown): string | number | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  return typeof payload.id === "string" || typeof payload.id === "number" ? payload.id : undefined;
}

function protocolResult(payload: unknown): unknown {
  return isRecord(payload) && "result" in payload ? payload.result : undefined;
}

function inferCodexVersion(payload: unknown): string | undefined {
  const result = protocolResult(payload);
  if (!isRecord(result)) {
    return undefined;
  }

  if (typeof result.userAgent === "string") {
    const match = result.userAgent.match(/effect-codex-app-server-probe\/(\S+)/u);
    if (match?.[1]) {
      return match[1];
    }
  }

  const thread = result.thread;
  return isRecord(thread) && typeof thread.cliVersion === "string" ? thread.cliVersion : undefined;
}

function turnInput(prompt: string): TurnStartInput {
  return [{ type: "text", text: prompt }];
}

function getTurnId(response: TurnStartResponse): string {
  return response.turn.id;
}

function readOnlyFullAccessSandbox(): SandboxPolicy {
  return {
    access: { type: "fullAccess" },
    networkAccess: false,
    type: "readOnly",
  };
}

function readOnlyRestrictedSandbox(): SandboxPolicy {
  return {
    access: {
      includePlatformDefaults: false,
      readableRoots: [],
      type: "restricted",
    },
    networkAccess: false,
    type: "readOnly",
  };
}

function workspaceWriteSandbox(): SandboxPolicy {
  return {
    networkAccess: false,
    readOnlyAccess: { type: "fullAccess" },
    type: "workspaceWrite",
    writableRoots: [],
  };
}

function granularApprovalPolicy(): ApprovalPolicy {
  return {
    granular: {
      mcp_elicitations: true,
      request_permissions: true,
      rules: true,
      sandbox_approval: true,
      skill_approval: true,
    },
  };
}

function scenarios(): ReadonlyArray<ProbeScenario> {
  return [
    {
      name: "simple",
      fileName: "simple.ndjson",
      description: "One thread and one turn with a deterministic text-only response.",
      runs: [
        {
          name: "simple",
          description: "Single text-only turn.",
          prompt: SIMPLE_PROMPT,
          steps: [{ type: "turn", label: "simple", prompt: SIMPLE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_read_only_on_request",
      fileName: "tool_call_read_only_on_request.ndjson",
      description:
        "Write a small probe file with read-only full filesystem visibility and on-request approvals.",
      runs: [
        {
          name: "read-only-on-request",
          description:
            "Write action under read-only full filesystem visibility with on-request approvals.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "write-probe-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_workspace_never",
      fileName: "tool_call_workspace_never.ndjson",
      description:
        "Write a small probe file with workspace-write sandbox policy and never approvals.",
      runs: [
        {
          name: "workspace-never",
          description:
            "Write action under workspace-write policy with never approvals for baseline no-prompt behavior.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [{ type: "turn", label: "write-probe-file", prompt: TOOL_CALL_WRITE_PROMPT }],
        },
      ],
    },
    {
      name: "tool_call_restricted_granular",
      fileName: "tool_call_restricted_granular.ndjson",
      description:
        "Write a small probe file with restricted read access and granular approval flags enabled.",
      runs: [
        {
          name: "restricted-granular",
          description:
            "Write action under restricted read access with granular approval flags enabled, intended to capture permission request flows when Codex escalates.",
          prompt: TOOL_CALL_WRITE_PROMPT,
          turnDefaults: {
            approvalPolicy: granularApprovalPolicy(),
            sandboxPolicy: readOnlyRestrictedSandbox(),
          },
          steps: [
            {
              type: "turn",
              label: "write-probe-file",
              prompt: TOOL_CALL_WRITE_PROMPT,
            },
          ],
        },
      ],
    },
    {
      name: "subagent",
      fileName: "subagent.ndjson",
      description: "One root turn that asks Codex to spawn two collab agents.",
      runs: [
        {
          name: "two-subagents",
          description: "Root turn asks for two subagents reading different files.",
          prompt: SUBAGENT_PROMPT,
          turnDefaults: {
            approvalPolicy: "on-request",
            sandboxPolicy: readOnlyFullAccessSandbox(),
          },
          steps: [{ type: "turn", label: "spawn-two-subagents", prompt: SUBAGENT_PROMPT }],
        },
      ],
    },
    {
      name: "multi_turn",
      fileName: "multi_turn.ndjson",
      description: "One thread with two sequential user turns.",
      runs: [
        {
          name: "two-turns-same-thread",
          description: "Second turn starts after the first root turn completes.",
          steps: [
            {
              type: "turn",
              label: "first",
              prompt: "Respond with exactly: first fixture turn complete",
            },
            {
              type: "turn",
              label: "second",
              prompt: "Respond with exactly: second fixture turn complete",
            },
          ],
        },
      ],
    },
    {
      name: "message_steering",
      fileName: "message_steering.ndjson",
      description: "One active turn receives an immediate turn/steer request.",
      runs: [
        {
          name: "immediate-steer",
          description: "Start a turn, then immediately steer the active root turn.",
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "steeredTurn",
              label: "steered",
              prompt: TOOL_CALL_WRITE_PROMPT,
              steer: "Actually, respond with exactly: steering fixture observed",
              turnOverrides: {
                approvalPolicy: "on-request",
                sandboxPolicy: readOnlyFullAccessSandbox(),
              },
            },
          ],
        },
      ],
    },
    {
      name: "turn_interrupt",
      fileName: "turn_interrupt.ndjson",
      description: "One active turn is interrupted before it finishes naturally.",
      runs: [
        {
          name: "interrupt-active-turn",
          description: "Start a long-running turn, then send turn/interrupt.",
          prompt: TURN_INTERRUPT_PROMPT,
          turnDefaults: {
            approvalPolicy: "never",
            sandboxPolicy: workspaceWriteSandbox(),
          },
          steps: [
            {
              type: "interruptedTurn",
              label: "interrupt-active-turn",
              prompt: TURN_INTERRUPT_PROMPT,
              interruptAfterMs: 1_500,
            },
          ],
        },
      ],
    },
    {
      name: "thread_rollback",
      fileName: "thread_rollback.ndjson",
      description:
        "One thread completes two turns, rolls back the most recent turn, then starts another turn.",
      runs: [
        {
          name: "rollback-one-turn",
          description:
            "Two completed turns, thread/rollback numTurns=1, then a post-rollback turn.",
          steps: [
            {
              type: "turn",
              label: "first-before-rollback",
              prompt: "Respond with exactly: rollback fixture first turn complete",
            },
            {
              type: "turn",
              label: "second-before-rollback",
              prompt: "Respond with exactly: rollback fixture second turn complete",
            },
            {
              type: "rollback",
              label: "rollback-latest-turn",
              numTurns: 1,
            },
            {
              type: "turn",
              label: "post-rollback",
              prompt: "Repeat the conversation verbatim.",
            },
          ],
        },
      ],
    },
  ];
}

function makeRecorder({
  outPath,
  scenario,
}: {
  readonly outPath: string;
  readonly scenario: ProbeScenario;
}): Effect.Effect<Recorder, PlatformError.PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let version = "unknown";
    const records: Array<Record<string, unknown>> = [];
    const setVersion = (nextVersion: string) =>
      Effect.sync(() => {
        version = nextVersion;
      });
    const writeRecord = (record: Record<string, unknown>) =>
      Effect.sync(() => {
        records.push(record);
      });
    const flush = () =>
      fs.writeFileString(
        outPath,
        `${[
          {
            type: "transcript_start",
            provider: "codex",
            protocol: "codex.app-server",
            version,
            scenario: scenario.name,
            metadata: {
              source: "codex-app-server-probe",
              fileName: scenario.fileName,
              description: scenario.description,
            },
          },
          ...records,
        ]
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
      );

    return { path: outPath, setVersion, writeRecord, flush };
  });
}

function makeCodexLayer({ recorder }: { readonly recorder: Recorder }) {
  const clientRequestMethodById = new Map<string, string>();
  const serverRequestMethodById = new Map<string, string>();

  return CodexClient.layerCommand({
    command: process.env.CODEX_BIN ?? "codex",
    args: ["app-server"],
    cwd: process.cwd(),
    logIncoming: true,
    logOutgoing: true,
    logger: (event) => {
      if (event.stage === "raw") {
        return Effect.void;
      }

      const id = protocolId(event.payload);
      const idKey = id === undefined ? undefined : String(id);
      const method = protocolMethod(event.payload);
      const messageKind = classifyJsonRpcPayload(event.payload);
      let correlatedRequestMethod: string | undefined;

      if (messageKind === "request" && idKey && method) {
        if (event.direction === "outgoing") {
          clientRequestMethodById.set(idKey, method);
        } else {
          serverRequestMethodById.set(idKey, method);
        }
      }

      if (messageKind === "response" || messageKind === "error_response") {
        if (event.direction === "incoming" && idKey) {
          correlatedRequestMethod = clientRequestMethodById.get(idKey);
          clientRequestMethodById.delete(idKey);
        }
        if (event.direction === "outgoing" && idKey) {
          correlatedRequestMethod = serverRequestMethodById.get(idKey);
          serverRequestMethodById.delete(idKey);
        }
      }

      const version = inferCodexVersion(event.payload);
      const updateVersion = version ? recorder.setVersion(version) : Effect.void;

      const label = method ?? correlatedRequestMethod;
      const record =
        event.direction === "outgoing"
          ? {
              type: "expect_outbound",
              ...(label ? { label } : {}),
              frame: event.payload,
            }
          : {
              type: "emit_inbound",
              ...(label ? { label } : {}),
              frame: event.payload,
            };

      return Effect.gen(function* () {
        yield* updateVersion;
        yield* recorder.writeRecord(record);
      }).pipe(Effect.ignore);
    },
  });
}

function installProbeHandlers({
  client,
  startTurn,
  completeTurn,
  beforeApprovalResponse,
}: {
  readonly client: CodexClient.CodexAppServerClientShape;
  readonly startTurn: (turnId: string) => Effect.Effect<void>;
  readonly completeTurn: (turnId: string) => Effect.Effect<void>;
  readonly beforeApprovalResponse: () => Effect.Effect<void>;
}) {
  return Effect.all(
    [
      client.handleServerRequest("item/tool/requestUserInput", (payload) =>
        Effect.succeed({
          answers: Object.fromEntries(
            payload.questions.map((question) => [
              question.id,
              {
                answers:
                  question.options && question.options.length > 0
                    ? [question.options[0]!.label]
                    : ["ok"],
              },
            ]),
          ),
        }),
      ),
      client.handleServerRequest("item/commandExecution/requestApproval", () =>
        beforeApprovalResponse().pipe(Effect.as({ decision: "accept" })),
      ),
      client.handleServerRequest("item/fileChange/requestApproval", () =>
        beforeApprovalResponse().pipe(Effect.as({ decision: "accept" })),
      ),
      client.handleServerRequest("item/permissions/requestApproval", (payload) =>
        beforeApprovalResponse().pipe(
          Effect.as({
            permissions: payload.permissions,
            scope: "turn" as const,
          }),
        ),
      ),
      client.handleServerRequest("mcpServer/elicitation/request", () =>
        Effect.succeed({ action: "accept" }),
      ),
      client.handleServerRequest("item/tool/call", (payload) =>
        Effect.succeed({
          contentItems: [
            {
              text: `Probe dynamic tool handler did not execute external tool: ${payload.tool}`,
              type: "inputText" as const,
            },
          ],
          success: false,
        }),
      ),
      client.handleServerRequest("applyPatchApproval", () =>
        Effect.succeed({ decision: "approved" }),
      ),
      client.handleServerRequest("execCommandApproval", () =>
        Effect.succeed({ decision: "approved" }),
      ),
      client.handleUnknownServerRequest((method) =>
        Effect.die(new Error(`Unhandled Codex app-server request in probe: ${method}`)),
      ),
      client.handleServerNotification("turn/started", (payload) =>
        startTurn(payload.turn.id).pipe(Effect.ignore),
      ),
      client.handleServerNotification("turn/completed", (payload) =>
        completeTurn(payload.turn.id).pipe(Effect.ignore),
      ),
    ],
    { discard: true },
  );
}

function runProbeSession({
  run,
  recorder,
}: {
  readonly scenario: ProbeScenario;
  readonly run: ProbeRun;
  readonly runIndex: number;
  readonly recorder: Recorder;
}) {
  return Effect.gen(function* () {
    const startedTurns = new Map<string, Deferred.Deferred<void>>();
    const completedTurns = new Map<string, Deferred.Deferred<void>>();
    let approvalGate: Deferred.Deferred<void> | undefined;
    const getStarted = (turnId: string) => {
      const existing = startedTurns.get(turnId);
      if (existing) {
        return Effect.succeed(existing);
      }
      return Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => startedTurns.set(turnId, deferred))),
      );
    };
    const getCompletion = (turnId: string) => {
      const existing = completedTurns.get(turnId);
      if (existing) {
        return Effect.succeed(existing);
      }
      return Deferred.make<void>().pipe(
        Effect.tap((deferred) => Effect.sync(() => completedTurns.set(turnId, deferred))),
      );
    };
    const startTurn = (turnId: string) =>
      getStarted(turnId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, void 0)));
    const completeTurn = (turnId: string) =>
      getCompletion(turnId).pipe(Effect.flatMap((deferred) => Deferred.succeed(deferred, void 0)));
    const beforeApprovalResponse = () =>
      approvalGate ? Deferred.await(approvalGate) : Effect.void;

    yield* Effect.gen(function* () {
      const client = yield* CodexClient.CodexAppServerClient;

      yield* installProbeHandlers({ client, startTurn, completeTurn, beforeApprovalResponse });

      yield* client.request("initialize", {
        clientInfo: {
          name: "effect-codex-app-server-probe",
          title: "Effect Codex App Server Probe",
          version: "0.0.0",
        },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: null,
        },
      });

      yield* client.notify("initialized", undefined);

      const thread = yield* client.request("thread/start", {});

      for (const [stepIndex, step] of run.steps.entries()) {
        if (step.type === "rollback") {
          yield* client.request("thread/rollback", {
            threadId: thread.thread.id,
            numTurns: step.numTurns,
          });
          continue;
        }

        const turnParams: TurnStartParams = {
          ...run.turnDefaults,
          ...("turnOverrides" in step ? step.turnOverrides : undefined),
          input: turnInput(step.prompt),
          threadId: thread.thread.id,
        };

        if (step.type === "steeredTurn") {
          approvalGate = yield* Deferred.make<void>();
        }

        const turn = yield* client.request("turn/start", turnParams);
        const turnId = getTurnId(turn);
        const started = yield* getStarted(turnId);
        yield* getCompletion(turnId);

        if (step.type === "steeredTurn") {
          yield* Deferred.await(started);
          yield* client.request("turn/steer", {
            expectedTurnId: turnId,
            input: turnInput(step.steer),
            threadId: thread.thread.id,
          });
          if (approvalGate) {
            yield* Deferred.succeed(approvalGate, void 0);
            approvalGate = undefined;
          }
        }

        if (step.type === "interruptedTurn") {
          yield* Effect.sleep(`${step.interruptAfterMs} millis`);
          yield* client.request("turn/interrupt", {
            threadId: thread.thread.id,
            turnId,
          });
        }

        const completed = yield* getCompletion(turnId);
        yield* Deferred.await(completed);
        void stepIndex;
      }
    }).pipe(
      Effect.provide(
        makeCodexLayer({
          recorder,
        }),
      ),
    );
  });
}

function runScenario({
  scenario,
  outPath,
}: {
  readonly scenario: ProbeScenario;
  readonly outPath: string;
}) {
  return Effect.gen(function* () {
    const recorder = yield* makeRecorder({ outPath, scenario });

    yield* Console.log(`Writing ${scenario.name} probe events to ${recorder.path}`);

    yield* Effect.forEach(
      scenario.runs,
      (run, runIndex) => runProbeSession({ scenario, run, runIndex, recorder }),
      { concurrency: 1 },
    );

    yield* recorder.writeRecord({
      type: "runtime_exit",
      status: "success",
    });
    yield* recorder.flush();
  });
}

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const requestedScenarios = parseScenarios();
  const allScenarios = scenarios();
  const outDir =
    readArgValue("--out-dir") ??
    process.env.CODEX_PROBE_OUT_DIR ??
    path.join(process.cwd(), DEFAULT_OUT_DIR);
  const singleOutPath = readArgValue("--out") ?? process.env.CODEX_PROBE_OUT;
  const selected = allScenarios.filter((scenario) => requestedScenarios.includes(scenario.name));

  if (selected.length === 0) {
    throw new Error("No probe scenarios selected.");
  }
  if (singleOutPath && selected.length !== 1) {
    throw new Error("--out / CODEX_PROBE_OUT can only be used with exactly one --scenario.");
  }

  yield* fs.makeDirectory(outDir, { recursive: true });

  yield* Effect.forEach(
    selected,
    (scenario) =>
      runScenario({
        scenario,
        outPath: singleOutPath ?? path.join(outDir, scenario.fileName),
      }),
    { concurrency: 1 },
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
