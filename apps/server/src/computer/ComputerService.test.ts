import type {
  ComputerAction,
  ComputerHostConnectInput,
  ComputerHostFrame,
  ComputerHostId,
  ComputerTaskId,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ComputerApprovals from "./ComputerApprovals.ts";
import * as ComputerAudit from "./ComputerAudit.ts";
import * as ComputerDecider from "./ComputerDecider.ts";
import * as ComputerService from "./ComputerService.ts";

const hello = (overrides: Partial<ComputerHostConnectInput> = {}): ComputerHostConnectInput => ({
  name: "JJ's MacBook",
  device: "mac",
  platform: "darwin",
  version: "1.0",
  controls: ["open_app", "volume", "lock_screen"],
  computerUse: true,
  accessibility: true,
  screenRecording: true,
  ...overrides,
});

/** A fixed SecureRandom with a counter, so every host, task and decision gets its own id. */
const testRandom = () => {
  let seed = 0;
  return SecureRandom.make((size) => {
    seed += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, seed, false);
    return bytes;
  });
};

const noGrounder = ComputerDecider.ComputerDecider.of({
  ask: () => Effect.succeed({ _tag: "not_configured" } as const),
  judge: () => Effect.succeed({ _tag: "not_configured" } as const),
});

const layerTest = (
  options: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly decider?: ComputerDecider.ComputerDecider["Service"];
  } = {},
) => {
  const settingsLayer = ServerSettings.layerTest(options.settings ?? {});
  const random = testRandom();
  const layerAudit = Layer.effect(
    ComputerAudit.ComputerAudit,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-computer-service-",
      });
      return yield* ComputerAudit.make(paths.join(directory, "computer", "audit.jsonl"));
    }),
  );
  const layerService = ComputerService.layer.pipe(
    Layer.provide(ComputerApprovals.layer),
    Layer.provide(layerAudit),
    Layer.provide(Layer.succeed(ComputerDecider.ComputerDecider, options.decider ?? noGrounder)),
    Layer.provide(settingsLayer),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: () => Effect.succeed(null),
      }),
    ),
    Layer.provide(Layer.succeed(SecureRandom.SecureRandom, random)),
  );
  return Layer.mergeAll(
    layerService,
    layerAudit,
    settingsLayer,
    Layer.succeed(SecureRandom.SecureRandom, random),
  ).pipe(Layer.provide(NodeServices.layer));
};

type FakeHost = {
  readonly hostId: ComputerHostId;
  readonly fiber: Fiber.Fiber<unknown, unknown>;
  readonly stops: Ref.Ref<ReadonlyArray<string>>;
  readonly authorize: (input: {
    readonly taskId: ComputerTaskId;
    readonly step: number;
    readonly action: ComputerAction;
  }) => ReturnType<ComputerService.ComputerService["Service"]["hostAuthorize"]>;
  readonly decide: (input: {
    readonly taskId: ComputerTaskId;
    readonly questions: Parameters<
      ComputerService.ComputerService["Service"]["hostDecide"]
    >[0]["questions"];
  }) => ReturnType<ComputerService.ComputerService["Service"]["hostDecide"]>;
};

/** A computer that answers every command the way a real one would. */
const startHost = (overrides: Partial<ComputerHostConnectInput> = {}) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const hostId = yield* Deferred.make<ComputerHostId>();
    const stops = yield* Ref.make<ReadonlyArray<string>>([]);
    const handle = (frame: ComputerHostFrame) =>
      Effect.gen(function* () {
        if (frame.kind === "welcome") {
          yield* Deferred.succeed(hostId, frame.hostId);
          return;
        }
        if (frame.kind === "stop") {
          yield* Ref.update(stops, (current) => [...current, frame.taskId]);
          return;
        }
        const id = yield* Deferred.await(hostId);
        yield* service.hostRespond({
          hostId: id,
          reply: {
            requestId: frame.requestId,
            ok: true,
            ...(frame.kind === "control" ? { done: "Done." } : {}),
          },
        });
      });
    const fiber = yield* Stream.runForEach(service.hostConnect(hello(overrides)), handle).pipe(
      Effect.forkScoped,
    );
    const id = yield* Deferred.await(hostId);
    return {
      hostId: id,
      fiber,
      stops,
      authorize: (input) =>
        service.hostAuthorize({
          hostId: id,
          taskId: input.taskId,
          step: input.step,
          observation: { app: "Messages", title: "Dana" },
          action: input.action,
        }),
      decide: (input) =>
        service.hostDecide({
          hostId: id,
          taskId: input.taskId,
          state: {},
          questions: input.questions,
        }),
    } satisfies FakeHost;
  });

const startUse = (
  overrides: Partial<Parameters<ComputerService.ComputerService["Service"]["startUse"]>[0]> = {},
) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    return yield* service.startUse({
      goal: "reply to Dana that I am on my way",
      text: "on my way",
      requester: "agent: test",
      ...overrides,
    });
  });

/** The approval a task is waiting for, once it exists. */
const waitForApproval = (taskId: ComputerTaskId) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const snapshots = yield* service.subscribe;
    const found = yield* snapshots.pipe(
      Stream.filter((snapshot) =>
        snapshot.approvals.some(
          (approval) => approval.binding.taskId === taskId && approval.state === "pending",
        ),
      ),
      Stream.runHead,
    );
    const approval =
      found._tag === "None"
        ? undefined
        : found.value.approvals.find(
            (candidate) => candidate.binding.taskId === taskId && candidate.state === "pending",
          );
    if (approval === undefined) return yield* Effect.die("no approval appeared");
    return approval;
  });

const waitForDecision = (taskId: ComputerTaskId) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const snapshots = yield* service.subscribe;
    const found = yield* snapshots.pipe(
      Stream.filter((snapshot) => {
        const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
        return task?.pendingDecision != null;
      }),
      Stream.runHead,
    );
    const decision =
      found._tag === "None"
        ? undefined
        : found.value.tasks.find((candidate) => candidate.taskId === taskId)?.pendingDecision;
    if (decision == null) return yield* Effect.die("no decision appeared");
    return decision;
  });

const taskOf = (taskId: ComputerTaskId) =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const status = yield* service.status;
    return status.tasks.find((task) => task.taskId === taskId);
  });

const click = (label: string, role = "button"): ComputerAction => ({
  kind: "click",
  ref: "r1",
  role,
  label,
});

const scroll = (): ComputerAction => ({ kind: "scroll", direction: "down" });

it.effect("a benign step is granted at once; a tap waits for the answer that grants it", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const host = yield* startHost();
    const task = yield* startUse();

    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 1, action: scroll() }),
      { ok: true, grant: "allow" },
    );

    const tap = yield* host
      .authorize({ taskId: task.taskId, step: 2, action: click("Send") })
      .pipe(Effect.forkScoped);
    const approval = yield* waitForApproval(task.taskId);
    assert.strictEqual(approval.binding.action.label, "Send");
    assert.strictEqual((yield* taskOf(task.taskId))?.waitingForApproval, approval.id);

    yield* service.respondToApproval({
      approvalId: approval.id,
      approve: true,
      decidedBy: "web: JJ",
    });
    assert.deepStrictEqual(yield* Fiber.join(tap), { ok: true, grant: "approved" });
    assert.strictEqual((yield* taskOf(task.taskId))?.waitingForApproval, null);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("Deny ends the task blocked and refuses the step", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const host = yield* startHost();
    const task = yield* startUse();

    const tap = yield* host
      .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
      .pipe(Effect.forkScoped);
    const approval = yield* waitForApproval(task.taskId);
    yield* service.respondToApproval({
      approvalId: approval.id,
      approve: false,
      decidedBy: "web: JJ",
    });

    assert.deepStrictEqual(yield* Fiber.join(tap), {
      ok: false,
      denied: "You said no on the approval screen.",
    });
    const ended = yield* taskOf(task.taskId);
    assert.strictEqual(ended?.status, "blocked");
    assert.strictEqual(ended?.reason, "You said no on the approval screen.");
    assert.isNull(ended?.waitingForApproval ?? null);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("the sixteenth authorization and a step past 90 s of working time are refused", () =>
  Effect.gen(function* () {
    const host = yield* startHost();

    const steps = yield* startUse({ goal: "scroll the list" });
    for (let step = 1; step <= 15; step += 1) {
      assert.deepStrictEqual(
        yield* host.authorize({ taskId: steps.taskId, step, action: scroll() }),
        { ok: true, grant: "allow" },
      );
    }
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: steps.taskId, step: 16, action: scroll() }),
      { ok: false, denied: "It did not finish within 15 steps." },
    );

    const timed = yield* startUse({ goal: "read the list" });
    yield* TestClock.adjust("91 seconds");
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: timed.taskId, step: 1, action: scroll() }),
      { ok: false, denied: "It was taking too long." },
    );
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a wait for a tap is not working time", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const host = yield* startHost();
    const task = yield* startUse();

    yield* TestClock.adjust("60 seconds");
    const tap = yield* host
      .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
      .pipe(Effect.forkScoped);
    const approval = yield* waitForApproval(task.taskId);
    yield* TestClock.adjust("30 seconds");
    yield* service.respondToApproval({ approvalId: approval.id, approve: true, decidedBy: "web" });
    yield* Fiber.join(tap);

    // 110 s of wall time, 30 of them waiting: 80 s of working time is still within the budget.
    yield* TestClock.adjust("20 seconds");
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 2, action: scroll() }),
      {
        ok: true,
        grant: "allow",
      },
    );
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a second task on a busy host is refused", () =>
  Effect.gen(function* () {
    yield* startHost();
    yield* startUse();
    const second = yield* startUse().pipe(Effect.flip);
    assert.strictEqual(second._tag, "ComputerError");
    assert.strictEqual(second.reason, "busy");
    assert.match(second.message, /busy with another task/);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("Stop cancels the pending approval and ends the task", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const host = yield* startHost();
    const task = yield* startUse();

    const tap = yield* host
      .authorize({ taskId: task.taskId, step: 1, action: click("Send") })
      .pipe(Effect.forkScoped);
    yield* waitForApproval(task.taskId);
    yield* service.stop({ by: "web: JJ" });

    assert.deepStrictEqual(yield* Fiber.join(tap), { ok: false, denied: "It was stopped." });
    assert.strictEqual((yield* taskOf(task.taskId))?.status, "stopped");
    const snapshot = yield* service.status;
    assert.isFalse(snapshot.approvals.some((approval) => approval.state === "pending"));
    assert.deepStrictEqual(yield* Ref.get(host.stops), [task.taskId]);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a host that goes away ends its task", () =>
  Effect.gen(function* () {
    const host = yield* startHost();
    const task = yield* startUse();
    yield* Fiber.interrupt(host.fiber);
    const ended = yield* taskOf(task.taskId);
    assert.strictEqual(ended?.status, "failed");
    assert.strictEqual(ended?.reason, "The computer disconnected.");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("with no grounder a judged click becomes a tap", () =>
  Effect.gen(function* () {
    const host = yield* startHost();
    const task = yield* startUse();

    const judged = yield* host
      .authorize({ taskId: task.taskId, step: 1, action: click("Save") })
      .pipe(Effect.forkScoped);
    const approval = yield* waitForApproval(task.taskId);
    assert.match(approval.binding.why, /could not be checked/);
    assert.strictEqual((yield* taskOf(task.taskId))?.waitingForApproval, approval.id);
    yield* Fiber.interrupt(judged);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("a grounder that answers 0.1 runs the click without a tap", () =>
  Effect.gen(function* () {
    const host = yield* startHost();
    const task = yield* startUse();
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 1, action: click("Save") }),
      { ok: true, grant: "allow" },
    );
    assert.isNull((yield* taskOf(task.taskId))?.waitingForApproval ?? null);
  }).pipe(
    Effect.provide(
      layerTest({
        decider: ComputerDecider.ComputerDecider.of({
          ask: () => Effect.succeed({ _tag: "not_configured" } as const),
          judge: () => Effect.succeed({ _tag: "judged", probability: 0.1 } as const),
        }),
      }),
    ),
  ),
);

it.effect("an answer naming a key that was not offered is dropped", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const host = yield* startHost();
    const task = yield* startUse();

    const decided = yield* host
      .decide({
        taskId: task.taskId,
        questions: {
          next: {
            type: "choice",
            instructions: "What next?",
            criteria: { c0: "Click Send", stuck: "None" },
          },
          risky: { type: "noul", instructions: "Could it send something?" },
        },
      })
      .pipe(Effect.forkScoped);
    const decision = yield* waitForDecision(task.taskId);

    const answers = yield* service.answerDecision({
      taskId: task.taskId,
      decisionId: decision.id,
      answers: {
        next: { choice: "c99", confidence: "high" },
        risky: { answer: true, confidence: "high" },
      },
      answeredBy: "agent: test",
    });
    assert.deepStrictEqual(answers, { risky: { type: "noul", probability: 0.9 } });
    assert.deepStrictEqual(yield* Fiber.join(decided), answers);
  }).pipe(Effect.provide(layerTest())),
);

it.effect("with approvals off a tap is granted at once and audited as skipped", () =>
  Effect.gen(function* () {
    const audit = yield* ComputerAudit.ComputerAudit;
    const host = yield* startHost();
    const task = yield* startUse();
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 1, action: click("Send") }),
      { ok: true, grant: "approved" },
    );
    assert.isNull((yield* taskOf(task.taskId))?.waitingForApproval ?? null);

    const lines = yield* audit.tail(50);
    const skipped = lines.find((line) => line.event === "approval_skipped");
    assert.isDefined(skipped);
    assert.strictEqual(skipped?.taskId, task.taskId);
    assert.strictEqual(skipped?.step, 1);
    assert.deepStrictEqual(skipped?.action, {
      kind: "click",
      ref: "r1",
      role: "button",
      label: "Send",
    });
    assert.isFalse(lines.some((line) => line.event === "approval.request"));
  }).pipe(Effect.provide(layerTest({ settings: { computerApprovals: "skip" } }))),
);

it.effect("refused steps stay refused with approvals off", () =>
  Effect.gen(function* () {
    const host = yield* startHost();
    const task = yield* startUse();
    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 1, action: { kind: "teleport" } }),
      {
        ok: false,
        denied: "not a step computer use takes (click, type, press, scroll, surface, pointer)",
      },
    );
    assert.strictEqual((yield* taskOf(task.taskId))?.status, "blocked");
  }).pipe(Effect.provide(layerTest({ settings: { computerApprovals: "skip" } }))),
);

it.effect("switching back to asking makes the next tap wait again", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const settings = yield* ServerSettings.ServerSettingsService;
    const host = yield* startHost();
    const task = yield* startUse();

    assert.deepStrictEqual(
      yield* host.authorize({ taskId: task.taskId, step: 1, action: click("Send") }),
      { ok: true, grant: "approved" },
    );

    yield* settings.updateSettings({ computerApprovals: "ask" });

    const tap = yield* host
      .authorize({ taskId: task.taskId, step: 2, action: click("Send") })
      .pipe(Effect.forkScoped);
    const approval = yield* waitForApproval(task.taskId);
    assert.strictEqual((yield* taskOf(task.taskId))?.waitingForApproval, approval.id);

    yield* service.respondToApproval({ approvalId: approval.id, approve: true, decidedBy: "web" });
    assert.deepStrictEqual(yield* Fiber.join(tap), { ok: true, grant: "approved" });
  }).pipe(Effect.provide(layerTest({ settings: { computerApprovals: "skip" } }))),
);

it.effect("the task records its thread, so an interrupt stops it", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    yield* startHost();
    const threadId = ThreadId.make("thread-1");
    const task = yield* startUse({ threadId });
    assert.strictEqual(task.threadId, threadId);
    yield* service.stopForThread(threadId);
    assert.strictEqual((yield* taskOf(task.taskId))?.status, "stopped");
  }).pipe(Effect.provide(layerTest())),
);

it.effect("an in-process host attaches and detaches", () =>
  Effect.gen(function* () {
    const service = yield* ComputerService.ComputerService;
    const frame = yield* Deferred.make<ComputerHostFrame>();
    const attached = yield* service.attachLocalHost({
      ...hello({ name: "This computer", device: "local" }),
      // A local host takes its frames from a queue it owns; this one only needs the welcome.
      send: (sent) => {
        Deferred.doneUnsafe(frame, Effect.succeed(sent));
      },
    });
    assert.strictEqual((yield* service.status).hosts.length, 1);
    assert.strictEqual((yield* Deferred.await(frame)).kind, "welcome");
    yield* attached.detach;
    assert.strictEqual((yield* service.status).hosts.length, 0);
  }).pipe(Effect.provide(layerTest())),
);
