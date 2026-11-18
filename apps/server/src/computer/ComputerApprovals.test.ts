import type { ComputerApprovalBinding } from "@t3tools/contracts";
import { ComputerApprovalLimitError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as TestClock from "effect/testing/TestClock";

import * as ComputerApprovals from "./ComputerApprovals.ts";

const binding = (text: string, label = "Message"): ComputerApprovalBinding => ({
  hostId: "mac_1",
  taskId: "cu_1",
  step: 3,
  app: "Messages",
  title: "Dana",
  url: "",
  action: { kind: "type", ref: "r7", role: "textbox", label, text },
  why: "typing into a field that is not a search or address box",
  goal: "tell Dana I am on my way",
  requester: "agent: opencode",
});

// A fixed SecureRandom with a counter, so every approval gets its own id.
const makeApprovals = Effect.gen(function* () {
  let seed = 0;
  const random = SecureRandom.make((size) => {
    seed += 1;
    return new Uint8Array(size).fill(seed);
  });
  return yield* ComputerApprovals.ComputerApprovals.pipe(
    Effect.provide(
      ComputerApprovals.layer.pipe(Layer.provide(Layer.succeed(SecureRandom.SecureRandom, random))),
    ),
  );
});

it.effect("an approval grants its own step once", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const approval = yield* approvals.create(binding("on my way"));
    assert.strictEqual(approval.state, "pending");
    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: binding("on my way") }),
      "pending",
    );

    assert.strictEqual(
      yield* approvals.decide({
        approvalId: approval.id,
        approve: true,
        decidedBy: "web: JJ's phone",
      }),
      "ok",
    );
    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: binding("on my way") }),
      "approved",
    );
    // Used up: a second take is not a second approval.
    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: binding("on my way") }),
      "unknown",
    );
    assert.strictEqual(
      yield* approvals.decide({ approvalId: approval.id, approve: true, decidedBy: "again" }),
      "not_pending",
    );
  }),
);

it.effect("binds the exact action: other text, step, task, window or host cannot take it", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const own = binding("on my way");
    const approval = yield* approvals.create(own);
    yield* approvals.decide({ approvalId: approval.id, approve: true, decidedBy: "web" });

    const others: ReadonlyArray<ComputerApprovalBinding> = [
      binding("send me your password"),
      { ...own, step: 4 },
      { ...own, taskId: "cu_2" },
      { ...own, title: "Mum" },
      { ...own, hostId: "mac_2" },
    ];
    for (const other of others)
      assert.strictEqual(
        yield* approvals.take({ approvalId: approval.id, binding: other }),
        "mismatch",
      );

    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: own }),
      "approved",
    );
  }),
);

it.effect("the digest does not collide when bytes move between fields", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const own = binding("ab", "c");
    const approval = yield* approvals.create(own);
    yield* approvals.decide({ approvalId: approval.id, approve: true, decidedBy: "web" });

    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: binding("a", "bc") }),
      "mismatch",
    );
    assert.strictEqual(
      yield* approvals.take({ approvalId: approval.id, binding: own }),
      "approved",
    );
  }),
);

it.effect("neither a late tap nor a late take grants anything", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const own = binding("x");

    const late = yield* approvals.create(own);
    yield* TestClock.adjust("60 seconds");
    assert.strictEqual(
      yield* approvals.decide({ approvalId: late.id, approve: true, decidedBy: "web" }),
      "expired",
    );
    assert.strictEqual(yield* approvals.take({ approvalId: late.id, binding: own }), "expired");

    // Approved in time but taken too late: still expired.
    const takenLate = yield* approvals.create(own);
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual(
      yield* approvals.decide({ approvalId: takenLate.id, approve: true, decidedBy: "web" }),
      "ok",
    );
    yield* TestClock.adjust("60 seconds");
    assert.strictEqual(
      yield* approvals.take({ approvalId: takenLate.id, binding: own }),
      "expired",
    );
  }),
);

it.effect("deny and cancel end it", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const own = binding("x");

    const denied = yield* approvals.create(own);
    assert.strictEqual(
      yield* approvals.decide({ approvalId: denied.id, approve: false, decidedBy: "web" }),
      "ok",
    );
    assert.strictEqual(yield* approvals.take({ approvalId: denied.id, binding: own }), "denied");

    const cancelled = yield* approvals.create(own);
    yield* approvals.cancelTask(own.taskId);
    assert.strictEqual(
      yield* approvals.take({ approvalId: cancelled.id, binding: own }),
      "cancelled",
    );
    assert.strictEqual(
      yield* approvals.decide({ approvalId: cancelled.id, approve: true, decidedBy: "web" }),
      "not_pending",
    );

    assert.strictEqual(
      yield* approvals.decide({ approvalId: "appr_nope", approve: true, decidedBy: "web" }),
      "unknown",
    );
    assert.strictEqual(yield* approvals.take({ approvalId: "appr_nope", binding: own }), "unknown");
  }),
);

it.effect("lists pending approvals first, then finished ones, newest first", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    const first = yield* approvals.create(binding("first"));
    yield* approvals.decide({ approvalId: first.id, approve: false, decidedBy: "web" });
    yield* approvals.create(binding("second"));

    const listed = yield* approvals.list;
    assert.deepStrictEqual(
      listed.map((approval) => approval.state),
      ["pending", "denied"],
    );
    assert.strictEqual(listed.at(0)?.binding.action.text, "second");
  }),
);

it.effect("refuses to hold more than 256 approvals", () =>
  Effect.gen(function* () {
    const approvals = yield* makeApprovals;
    for (let index = 0; index < 256; index += 1) yield* approvals.create(binding(`text ${index}`));

    const error = yield* approvals.create(binding("one too many")).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ComputerApprovalLimitError");
    assert.strictEqual(error.limit, 256);
    assert.instanceOf(error, ComputerApprovalLimitError);
  }),
);
