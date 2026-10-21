import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type DelegatedLaunchBinding,
  type CodexPoolBindingState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";

import {
  classifyPoolRefusal,
  codexPoolLaunchArgs,
  codexPoolPrepareRequest,
  makeCodexPoolControl,
} from "./CodexPoolControl.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const INSTANCE = ProviderInstanceId.make("codex_pool");
const BINDING_ID = "a".repeat(48);
const ACCOUNT = "codex:credential:acct-1";
const CAPABILITIES = {
  controlOperations: ["capabilities", "prepare", "state", "touch", "release", "cancel", "resume"],
  boundLaunch: "app-server-stdio",
  origin: "https://pool.example.test:8445",
  proxyProtocolVersion: 2,
  supportsWebsockets: false,
  requestMaxRetries: 0,
  streamMaxRetries: 0,
};

type Request = { readonly operation: string } & Record<string, any>;
type Reply = { readonly exit?: number; readonly body: unknown } | { readonly raw: string };
type Responder = (request: Request, nowMs: number) => Reply;

const ok = (operation: string, result: unknown): Reply => ({
  body: { protocolVersion: 2, operation, result },
});

/** A launcher speaking protocol v1 over stdin/stdout, recording every invocation. */
const fakeLauncher = (reply: Responder) => {
  const calls: Array<{ command: string; args: ReadonlyArray<string>; request: Request }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const { command: binary, args } = command as unknown as {
        command: string;
        args: ReadonlyArray<string>;
      };
      const input = yield* Deferred.make<Request>();
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const answer = yield* Deferred.await(input).pipe(
        Effect.map((request) => {
          calls.push({ command: binary, args, request });
          const reply_ = reply(request, nowMs);
          return "raw" in reply_
            ? { text: reply_.raw, exit: 0 }
            : { text: encodeJson(reply_.body), exit: reply_.exit ?? 0 };
        }),
        Effect.cached,
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: answer.pipe(Effect.map(({ exit }) => ChildProcessSpawner.ExitCode(exit))),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.collect<Uint8Array>().pipe(
          Sink.mapEffect((chunks) =>
            Deferred.succeed(
              input,
              decodeJson(new TextDecoder().decode(Buffer.concat(chunks))) as Request,
            ).pipe(Effect.asVoid),
          ),
        ),
        stdout: Stream.fromEffect(answer).pipe(
          Stream.map(({ text }) => text),
          Stream.encodeText,
        ),
        stderr: Stream.encodeText(Stream.make("diagnostic prose is never parsed")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { calls, spawner };
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const readyFor = (request: Request, nowMs: number, overrides: Record<string, unknown> = {}) => {
  const prepare = request.request;
  return ok("prepare", {
    protocolVersion: 2,
    status: "ready",
    checkedAt: iso(nowMs),
    expiresAt: iso(nowMs + 30_000),
    ordinaryUsageAllowed: true,
    quotaDomains: [ACCOUNT],
    bindingId: BINDING_ID,
    basePath: `/v1/delegated-launch/bindings/${BINDING_ID}/sessions/${prepare.sessionId}`,
    provider: "codex",
    model: prepare.model,
    sessionId: prepare.sessionId,
    windows: [{ id: "primary", usedPercent: 12, resetsAt: iso(nowMs + 3_600_000) }],
    ...overrides,
  });
};

const poolWith = (reply: Responder, launchArgs = "") => {
  const launcher = fakeLauncher(reply);
  return makeCodexPoolControl({
    instanceId: INSTANCE,
    binaryPath: "/opt/fake/codex-t3",
    environment: { CODEX_T3_ACCOUNT: "pool" },
    launchArgs,
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, launcher.spawner),
    Effect.provide(NodeCrypto.layer),
    Effect.map((pool) => ({ pool, calls: launcher.calls })),
  );
};

const prepareInput = (blockedQuotaDomains: ReadonlyArray<string> = []) => ({
  runId: "run-1",
  generation: 1,
  model: "gpt-6.1-sol",
  blockedQuotaDomains,
});

const withCapabilities =
  (rest: Responder): Responder =>
  (request, nowMs) =>
    request.operation === "capabilities" ? ok("capabilities", CAPABILITIES) : rest(request, nowMs);
const standard = withCapabilities((request, nowMs) => readyFor(request, nowMs));

const requestFor = (input: Parameters<typeof codexPoolPrepareRequest>[0]) =>
  codexPoolPrepareRequest(input).pipe(Effect.provide(NodeCrypto.layer));

it.effect("prepares a ready binding through the configured launcher with nonsecret argv", () =>
  Effect.gen(function* () {
    const { pool, calls } = yield* poolWith(standard);
    const outcome = yield* pool.prepare(prepareInput(["codex:credential:acct-2"]));
    assert.equal(outcome.status, "ready");
    if (outcome.status !== "ready") return;
    assert.equal(outcome.binding.protocol, "codex-t3-pool-v2");
    assert.equal(outcome.binding.instanceId, INSTANCE);
    assert.deepEqual(outcome.binding.result.quotaDomains, [ACCOUNT]);
    assert.deepEqual(
      calls.map((c) => [c.command, ...c.args, c.request.operation]),
      [
        ["/opt/fake/codex-t3", "pool-control", "capabilities"],
        ["/opt/fake/codex-t3", "pool-control", "prepare"],
      ],
    );
    assert.deepEqual(calls[1]!.request, {
      protocolVersion: 2,
      operation: "prepare",
      request: outcome.binding.prepareRequest,
    });
    assert.deepEqual(outcome.binding.prepareRequest.blockedQuotaDomains, [
      "codex:credential:acct-2",
    ]);
  }),
);

it.effect("derives stable request and session identity per logical launch", () =>
  Effect.gen(function* () {
    const base = { ...prepareInput(), instanceId: INSTANCE };
    const first = yield* requestFor({
      ...base,
      blockedQuotaDomains: ["codex:credential:b", "codex:credential:a", "codex:credential:a"],
    });
    const duplicate = yield* requestFor({
      ...base,
      blockedQuotaDomains: [
        "codex:credential:a",
        "codex:credential:b",
        // Window-scoped and foreign identities are not proxy quota domains.
        "codex:credential:a:quota:seven_day_opus",
        "claudeAgent:account:x@example.com",
      ],
    });
    const widened = yield* requestFor({
      ...base,
      blockedQuotaDomains: ["codex:credential:a", "codex:credential:b", "codex:credential:c"],
    });
    const nextGeneration = yield* requestFor({
      ...base,
      generation: 2,
      blockedQuotaDomains: ["codex:credential:a", "codex:credential:b"],
    });
    assert.deepEqual(first, duplicate);
    assert.deepEqual(first?.blockedQuotaDomains, ["codex:credential:a", "codex:credential:b"]);
    assert.match(first!.clientRequestId, /^t3\.[a-f0-9]{40}$/);
    assert.notEqual(widened?.clientRequestId, first?.clientRequestId);
    assert.equal(widened?.sessionId, first?.sessionId);
    assert.notEqual(nextGeneration?.sessionId, first?.sessionId);
    const tooMany = yield* requestFor({
      ...base,
      blockedQuotaDomains: Array.from({ length: 65 }, (_, i) => `codex:credential:a${i}`),
    });
    assert.isUndefined(tooMany);
  }),
);

it.effect.each([
  { name: "websocket transport", capabilities: { ...CAPABILITIES, supportsWebsockets: true } },
  { name: "native retries", capabilities: { ...CAPABILITIES, requestMaxRetries: 3 } },
  {
    name: "missing operation",
    capabilities: { ...CAPABILITIES, controlOperations: ["capabilities", "prepare"] },
  },
  { name: "unknown field", capabilities: { ...CAPABILITIES, experimental: true } },
  {
    name: "plain-http origin",
    capabilities: { ...CAPABILITIES, origin: "http://pool.example.test" },
  },
])("fails closed on an incompatible wrapper: $name", ({ capabilities }) =>
  Effect.gen(function* () {
    const { pool, calls } = yield* poolWith((request, nowMs) =>
      request.operation === "capabilities"
        ? ok("capabilities", capabilities)
        : readyFor(request, nowMs),
    );
    assert.deepEqual(yield* pool.prepare(prepareInput()), { status: "unverified" });
    assert.deepEqual(
      calls.map((c) => c.request.operation),
      ["capabilities"],
    );
  }),
);

it.effect("fails closed when custom launch arguments would bypass the bound process", () =>
  Effect.gen(function* () {
    const { pool, calls } = yield* poolWith(standard, "--profile other");
    assert.deepEqual(yield* pool.prepare(prepareInput()), { status: "unverified" });
    assert.isFalse(calls.some((c) => c.request.operation === "prepare"));
  }),
);

const invalidPrepares: ReadonlyArray<readonly [string, Responder]> = [
  [
    "an error envelope",
    () => ({ exit: 1, body: { protocolVersion: 2, error: { code: "timeout" } } }),
  ],
  ["non-JSON output", () => ({ raw: "Traceback (most recent call last)" })],
  ["an oversized response", () => ({ raw: "x".repeat(20_000) })],
  [
    "a protocol version mismatch",
    (request, nowMs) => ({
      body: { ...(readyFor(request, nowMs) as { body: object }).body, protocolVersion: 1 },
    }),
  ],
  [
    "a stale ready result",
    (request, nowMs) =>
      readyFor(request, nowMs, { checkedAt: iso(nowMs - 31_000), expiresAt: iso(nowMs + 1_000) }),
  ],
  [
    "a ready result for a blocked account",
    (request, nowMs) => readyFor(request, nowMs, { quotaDomains: ["codex:credential:blocked"] }),
  ],
  [
    "a ready result for another session",
    (request, nowMs) => readyFor(request, nowMs, { sessionId: "t3.other" }),
  ],
  [
    "a ready result with an exhausted window",
    (request, nowMs) =>
      readyFor(request, nowMs, {
        windows: [{ id: "primary", usedPercent: 100, resetsAt: iso(nowMs + 60_000) }],
      }),
  ],
];
it.effect.each(invalidPrepares.map(([name, reply]) => ({ name, reply })))(
  "treats $name as unverified",
  ({ reply }) =>
    Effect.gen(function* () {
      const { pool } = yield* poolWith(withCapabilities(reply));
      assert.deepEqual(yield* pool.prepare(prepareInput(["codex:credential:blocked"])), {
        status: "unverified",
      });
    }),
);

const denied = (nowMs: number, fields: Record<string, unknown>) =>
  ok("prepare", {
    protocolVersion: 2,
    checkedAt: iso(nowMs),
    expiresAt: iso(nowMs + 60_000),
    ordinaryUsageAllowed: false,
    ...fields,
  });

it.effect("maps verified account exhaustion to waiting and everything else to unverified", () =>
  Effect.gen(function* () {
    const { pool: exhausted } = yield* poolWith(
      withCapabilities((_, nowMs) =>
        denied(nowMs, {
          status: "waiting",
          code: "usage_limit",
          quotaScope: "account",
          quotaDomains: [ACCOUNT],
        }),
      ),
    );
    assert.deepEqual(yield* exhausted.prepare(prepareInput()), {
      status: "waiting",
      quotaDomains: [ACCOUNT],
    });
    for (const [code, quotaScope] of [
      ["throttled", "transient"],
      ["model_capacity", "model"],
      ["quota_unverified", "unknown"],
    ] as const) {
      const { pool } = yield* poolWith(
        withCapabilities((_, nowMs) =>
          denied(nowMs, { status: "unverified", code, quotaScope, quotaDomains: [] }),
        ),
      );
      assert.deepEqual(yield* pool.prepare(prepareInput()), { status: "unverified" });
    }
  }),
);

it.effect("reads authenticated state and acknowledges refusals by version only", () =>
  Effect.gen(function* () {
    const state: CodexPoolBindingState = {
      protocolVersion: 2,
      state: "established",
      active: false,
      executorAttempts: 1,
      refusalVersion: 3,
      refusal: { code: "throttled", quotaScope: "transient", quotaDomains: [] },
    };
    let foreignRefusal = false;
    const { pool, calls } = yield* poolWith(
      withCapabilities((request, nowMs) => {
        switch (request.operation) {
          case "prepare":
            return readyFor(request, nowMs);
          case "state":
            return ok("state", {
              ...state,
              refusal: {
                ...state.refusal,
                ...(foreignRefusal ? { bindingId: "b".repeat(48) } : {}),
              },
            });
          case "resume":
            return ok("resume", { status: "acknowledged" });
          case "touch":
            return ok("touch", { status: "active" });
          default:
            return ok(request.operation, { status: "released" });
        }
      }),
    );
    const outcome = yield* pool.prepare(prepareInput());
    if (outcome.status !== "ready") return assert.fail("expected ready");
    assert.deepEqual(yield* pool.state(outcome.binding), state);
    foreignRefusal = true;
    assert.isUndefined(yield* pool.state(outcome.binding));
    const before = calls.length;
    assert.isFalse(yield* pool.resume(outcome.binding, 0));
    assert.equal(calls.length, before);
    assert.isTrue(yield* pool.resume(outcome.binding, 3));
    assert.isTrue(yield* pool.touch(outcome.binding));
    assert.isTrue(yield* pool.release(outcome.binding));
    assert.isTrue(yield* pool.cancel(outcome.binding.prepareRequest.clientRequestId));
    assert.deepEqual(calls.find((c) => c.request.operation === "resume")!.request, {
      protocolVersion: 2,
      operation: "resume",
      binding: {
        bindingId: BINDING_ID,
        basePath: outcome.binding.result.basePath,
        sessionId: outcome.binding.result.sessionId,
      },
      expectedRefusalVersion: 3,
    });
    assert.deepEqual(calls.at(-1)!.request, {
      protocolVersion: 2,
      operation: "cancel",
      clientRequestId: outcome.binding.prepareRequest.clientRequestId,
    });
  }),
);

it.effect("reports failed lifecycle calls as false instead of failing the session", () =>
  Effect.gen(function* () {
    const { pool } = yield* poolWith(
      withCapabilities((request, nowMs) =>
        request.operation === "prepare"
          ? readyFor(request, nowMs)
          : { exit: 1, body: { protocolVersion: 2, error: { code: "conflict" } } },
      ),
    );
    const outcome = yield* pool.prepare(prepareInput());
    if (outcome.status !== "ready") return assert.fail("expected ready");
    assert.isUndefined(yield* pool.state(outcome.binding));
    assert.isFalse(yield* pool.touch(outcome.binding));
    assert.isFalse(yield* pool.release(outcome.binding));
  }),
);

it.effect("builds a single nonsecret pool-launch argument from the persisted binding", () =>
  Effect.gen(function* () {
    const { pool } = yield* poolWith(standard);
    const outcome = yield* pool.prepare(prepareInput());
    if (outcome.status !== "ready") return assert.fail("expected ready");
    const [mode, payload, ...rest] = codexPoolLaunchArgs(outcome.binding);
    assert.equal(mode, "pool-launch");
    assert.lengthOf(rest, 0);
    assert.deepEqual(decodeJson(payload!), {
      protocolVersion: 2,
      prepareRequest: outcome.binding.prepareRequest,
      binding: outcome.binding.result,
      options: {},
    });
  }),
);

const stateWith = (fields: Partial<CodexPoolBindingState>): CodexPoolBindingState => ({
  protocolVersion: 2,
  state: "pending",
  active: false,
  executorAttempts: 0,
  refusalVersion: 0,
  ...fields,
});

it("separates account exhaustion from throttle and model capacity", () => {
  assert.deepEqual(
    classifyPoolRefusal(
      stateWith({
        refusalVersion: 1,
        refusal: { code: "usage_limit", quotaScope: "account", quotaDomains: [ACCOUNT] },
      }),
      false,
    ),
    { scope: { type: "account" }, domains: [ACCOUNT] },
  );
  for (const refusal of [
    { code: "throttled", quotaScope: "transient", quotaDomains: [] },
    { code: "model_capacity", quotaScope: "model", quotaDomains: [] },
  ] as const)
    assert.deepEqual(classifyPoolRefusal(stateWith({ refusalVersion: 1, refusal }), true), {
      scope: { type: "candidate" },
    });
  // An unknown scope may be the whole account; never assume independence.
  assert.deepEqual(
    classifyPoolRefusal(
      stateWith({
        refusalVersion: 1,
        refusal: { code: "quota_unverified", quotaScope: "unknown", quotaDomains: [] },
      }),
      false,
    ),
    { scope: { type: "account" } },
  );
  assert.deepEqual(classifyPoolRefusal(stateWith({ state: "invalid" }), false), {
    scope: { type: "candidate" },
  });
  assert.isUndefined(classifyPoolRefusal(stateWith({}), false));
  assert.isUndefined(classifyPoolRefusal(undefined, false));
  assert.deepEqual(classifyPoolRefusal(undefined, true), { scope: { type: "account" } });
});

// Cross-contract check against the wrapper's own validator (dotfiles
// `scripts/codex_t3_contract.py`). Opt-in: CI has no dotfiles checkout.
const wrapperContractDir = process.env.CODEX_T3_CONTRACT_DIR;
const WRAPPER_CHECK = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "import codex_t3_contract as contract",
  "for line in sys.stdin:",
  "    item = json.loads(line)",
  "    check = contract.control if item['kind'] == 'control' else contract.launch",
  "    check(contract.loads(json.dumps(item['value'])))",
  "print('accepted')",
].join("\n");

it.live.skipIf(!wrapperContractDir)(
  "emits control requests and a pool-launch payload the wrapper contract accepts",
  () =>
    Effect.gen(function* () {
      const { pool, calls } = yield* poolWith(
        withCapabilities((request, nowMs) => {
          switch (request.operation) {
            case "prepare":
              return readyFor(request, nowMs);
            case "state":
              return ok("state", {
                protocolVersion: 2,
                state: "established",
                active: false,
                executorAttempts: 1,
                refusalVersion: 2,
              });
            case "resume":
              return ok("resume", { status: "acknowledged" });
            case "touch":
              return ok("touch", { status: "active" });
            default:
              return ok(request.operation, { status: "released" });
          }
        }),
      );
      const outcome = yield* pool.prepare(prepareInput(["codex:credential:acct-9"]));
      if (outcome.status !== "ready") return assert.fail("expected ready");
      yield* pool.state(outcome.binding);
      yield* pool.touch(outcome.binding);
      yield* pool.resume(outcome.binding, 2);
      yield* pool.release(outcome.binding);
      yield* pool.cancel(outcome.binding.prepareRequest.clientRequestId);
      const [, payload] = codexPoolLaunchArgs(outcome.binding);
      const lines = [
        ...calls.map((c) => encodeJson({ kind: "control", value: c.request })),
        encodeJson({ kind: "launch", value: decodeJson(payload!) }),
      ];
      assert.lengthOf(calls, 7);
      const runner = yield* ProcessRunner.ProcessRunner;
      const result = yield* runner.run({
        command: "python3",
        args: ["-I", "-c", WRAPPER_CHECK, wrapperContractDir!],
        stdin: `${lines.join("\n")}\n`,
        timeout: "20 seconds",
      });
      assert.equal(result.stdout.trim(), "accepted");
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it("does not turn integration refusals into capacity exhaustion", () => {
  for (const code of [
    "model_mismatch",
    "transport_unsupported",
    "invalid_request",
    "upstream_error",
    "authentication_required",
  ] as const) {
    assert.isUndefined(
      classifyPoolRefusal(
        stateWith({ refusal: { code, quotaScope: "unknown", quotaDomains: [ACCOUNT] } }),
        true,
      ),
    );
  }
});

const producerFixture = process.env.QUOTA_CONTRACT_EXPORT;
it.effect.skipIf(!producerFixture)(
  "classifies actual proxy output after real wrapper validation",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const mode of ["throttle", "capacity"]) {
        const fixture = JSON.parse(yield* fs.readFileString(`${producerFixture}/${mode}.json`));
        const envelope = JSON.parse(
          yield* fs.readFileString(`${producerFixture}/${mode}-wrapper.json`),
        );
        const { pool } = yield* poolWith(withCapabilities(() => ({ body: envelope })));
        const binding: DelegatedLaunchBinding = {
          protocol: "codex-t3-pool-v2",
          instanceId: INSTANCE,
          result: fixture.ready,
          prepareRequest: {
            clientRequestId: "request",
            sessionId: fixture.ready.sessionId,
            provider: "codex",
            model: fixture.ready.model,
            blockedQuotaDomains: [],
          },
        };
        const state = yield* pool.state(binding);
        assert.deepEqual(state, fixture.state);
        assert.deepEqual(
          classifyPoolRefusal(state, false),
          mode === "throttle"
            ? { scope: { type: "attempt", domain: "codex:credential:synthetic-account" } }
            : { scope: { type: "candidate" } },
        );
        const mismatch = yield* pool.state({
          ...binding,
          result: { ...binding.result, quotaDomains: [ACCOUNT] },
        });
        assert.equal(mismatch, undefined);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("excludes attempted identities without inventing exhausted domains", () =>
  Effect.gen(function* () {
    const input = {
      ...prepareInput(),
      instanceId: INSTANCE,
      blockedQuotaDomains: ["launch:attempt:codex:credential:attempted"],
    };
    const request = yield* requestFor(input);
    assert.deepEqual(request?.blockedQuotaDomains, ["codex:credential:attempted"]);
    assert.deepEqual(yield* requestFor(input), request);
    assert.notEqual(
      (yield* requestFor({ ...input, blockedQuotaDomains: [] }))?.clientRequestId,
      request?.clientRequestId,
    );
  }),
);
