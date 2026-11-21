// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/companion/src/executor/approvals.ts and
// src/computer/approvals.zig), Apache-2.0, Copyright 2026 Jay Leaton. Modified for Ada.
// SHA-256 over a binding is pure and runs inside Ref.modify, so it cannot yield to the Effect Crypto service.
// @effect-diagnostics nodeBuiltinImport:off
import type {
  ComputerApproval,
  ComputerApprovalBinding,
  ComputerApprovalDecideResult,
  ComputerApprovalId,
  ComputerApprovalState,
  ComputerApprovalTakeResult,
  ComputerTaskId,
} from "@t3tools/contracts";
import { ComputerApprovalLimitError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as NodeCrypto from "node:crypto";

/**
 * A person's tap for one consequential step. An approval is bound to the host, the task, the step, what was on
 * screen and the exact action, by a SHA-256 digest of all of it. It lasts 60 s, is used once, and only the step
 * it was made for can take it. Kept in memory: a restart forgets every pending approval, which then never runs.
 */

const TTL_MS = 60_000;
/** Finished approvals are kept this long for the card's last state, then dropped. */
const KEPT_FINISHED_MS = 10 * 60_000;
const MAX_APPROVALS = 256;

/** The action fields the digest covers, in this order. `why` is display text, so it is not one of them. */
const ACTION_DIGEST_FIELDS = [
  "kind",
  "ref",
  "role",
  "label",
  "text",
  "key",
  "fieldRole",
  "fieldLabel",
  "direction",
  "what",
  "name",
] as const;

/** SHA-256 over the step and every field, each length-prefixed, so no two different bindings share a digest. */
function approvalDigest(binding: ComputerApprovalBinding): string {
  const hash = NodeCrypto.createHash("sha256");
  const step = new Uint8Array(4);
  new DataView(step.buffer).setUint32(0, binding.step, true);
  hash.update(step);
  const fields = [
    binding.hostId,
    binding.taskId,
    binding.app,
    binding.title,
    binding.url,
    ...ACTION_DIGEST_FIELDS.map((field) => binding.action[field] ?? ""),
  ];
  for (const field of fields) {
    const data = new TextEncoder().encode(field);
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(data.length), true);
    hash.update(length);
    hash.update(data);
  }
  return hash.digest("hex");
}

interface StoredApproval {
  readonly id: ComputerApprovalId;
  readonly binding: ComputerApprovalBinding;
  /** The binding as a client that cannot answer approvals sees it, fixed when the approval is made. */
  readonly readerBinding: ComputerApprovalBinding;
  readonly digest: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly state: ComputerApprovalState;
  readonly decidedBy: string;
}

const expired = (approval: StoredApproval, nowMs: number): StoredApproval =>
  (approval.state === "pending" || approval.state === "approved") && nowMs >= approval.expiresAtMs
    ? { ...approval, state: "expired" }
    : approval;

const pruned = (
  approvals: ReadonlyArray<StoredApproval>,
  nowMs: number,
): ReadonlyArray<StoredApproval> =>
  approvals
    .map((approval) => expired(approval, nowMs))
    .filter(
      (approval) =>
        approval.state === "pending" || nowMs - approval.createdAtMs <= KEPT_FINISHED_MS,
    );

const view = (approval: StoredApproval, revealTypedText: boolean): ComputerApproval => ({
  id: approval.id,
  binding: revealTypedText ? approval.binding : approval.readerBinding,
  createdAt: DateTime.makeUnsafe(approval.createdAtMs),
  expiresAt: DateTime.makeUnsafe(approval.expiresAtMs),
  state: approval.state,
  decidedBy: approval.decidedBy,
});

export class ComputerApprovals extends Context.Service<
  ComputerApprovals,
  {
    readonly create: (input: {
      readonly binding: ComputerApprovalBinding;
      readonly readerBinding: ComputerApprovalBinding;
    }) => Effect.Effect<ComputerApproval, ComputerApprovalLimitError>;
    readonly decide: (input: {
      readonly approvalId: ComputerApprovalId;
      readonly approve: boolean;
      readonly decidedBy: string;
    }) => Effect.Effect<ComputerApprovalDecideResult>;
    /**
     * The waiting step's check. It re-sends its binding, so an approval can only ever grant the exact action it
     * was made for.
     */
    readonly take: (input: {
      readonly approvalId: ComputerApprovalId;
      readonly binding: ComputerApprovalBinding;
    }) => Effect.Effect<ComputerApprovalTakeResult>;
    /** The task ended or was stopped: its approvals, answered or not, can no longer be granted. */
    readonly cancelTask: (taskId: ComputerTaskId) => Effect.Effect<void>;
    /**
     * Every approval still pending, then the ones that ended in the last ten minutes, newest first. Without
     * `revealTypedText`, each carries its reader binding.
     */
    readonly list: (input: {
      readonly revealTypedText: boolean;
    }) => Effect.Effect<ReadonlyArray<ComputerApproval>>;
  }
>()("t3/computer/ComputerApprovals") {}

const make = Effect.fn("computer.approvals.make")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const approvalsRef = yield* Ref.make<ReadonlyArray<StoredApproval>>([]);

  const create: ComputerApprovals["Service"]["create"] = Effect.fn("computer.approvals.create")(
    function* ({ binding, readerBinding }) {
      const nowMs = yield* Clock.currentTimeMillis;
      const id: ComputerApprovalId = `appr_${yield* random.uuidV4()}`;
      const created = yield* Ref.modify(
        approvalsRef,
        (current): readonly [StoredApproval | null, ReadonlyArray<StoredApproval>] => {
          const kept = pruned(current, nowMs);
          if (kept.length >= MAX_APPROVALS) return [null, kept];
          const approval: StoredApproval = {
            id,
            binding,
            readerBinding,
            digest: approvalDigest(binding),
            createdAtMs: nowMs,
            expiresAtMs: nowMs + TTL_MS,
            state: "pending",
            decidedBy: "",
          };
          return [approval, [...kept, approval]];
        },
      );
      if (created === null) return yield* new ComputerApprovalLimitError({ limit: MAX_APPROVALS });
      return view(created, true);
    },
  );

  const decide: ComputerApprovals["Service"]["decide"] = Effect.fn("computer.approvals.decide")(
    function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      return yield* Ref.modify(
        approvalsRef,
        (current): readonly [ComputerApprovalDecideResult, ReadonlyArray<StoredApproval>] => {
          const index = current.findIndex((approval) => approval.id === input.approvalId);
          if (index === -1) return ["unknown", current];
          const approval = expired(current[index]!, nowMs);
          const next = [...current];
          next[index] = approval;
          if (approval.state === "expired") return ["expired", next];
          if (approval.state !== "pending") return ["not_pending", next];
          next[index] = {
            ...approval,
            state: input.approve ? "approved" : "denied",
            decidedBy: input.decidedBy,
          };
          return ["ok", next];
        },
      );
    },
  );

  const take: ComputerApprovals["Service"]["take"] = Effect.fn("computer.approvals.take")(
    function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const digest = approvalDigest(input.binding);
      return yield* Ref.modify(
        approvalsRef,
        (current): readonly [ComputerApprovalTakeResult, ReadonlyArray<StoredApproval>] => {
          const index = current.findIndex((approval) => approval.id === input.approvalId);
          if (index === -1) return ["unknown", current];
          const stored = current[index]!;
          if (stored.digest !== digest) return ["mismatch", current];
          const approval = expired(stored, nowMs);
          const next = [...current];
          next[index] = approval;
          if (approval.state === "approved") {
            next[index] = { ...approval, state: "used" };
            return ["approved", next];
          }
          // Used up: a second take is not a second approval.
          if (approval.state === "used") return ["unknown", next];
          return [approval.state, next];
        },
      );
    },
  );

  const cancelTask: ComputerApprovals["Service"]["cancelTask"] = Effect.fn(
    "computer.approvals.cancelTask",
  )(function* (taskId) {
    yield* Ref.update(approvalsRef, (current) =>
      current.map((approval) =>
        (approval.state === "pending" || approval.state === "approved") &&
        approval.binding.taskId === taskId
          ? { ...approval, state: "cancelled" }
          : approval,
      ),
    );
  });

  const list: ComputerApprovals["Service"]["list"] = Effect.fn("computer.approvals.list")(
    function* (input) {
      const nowMs = yield* Clock.currentTimeMillis;
      const current = yield* Ref.modify(
        approvalsRef,
        (approvals): readonly [ReadonlyArray<StoredApproval>, ReadonlyArray<StoredApproval>] => {
          const kept = pruned(approvals, nowMs);
          return [kept, kept];
        },
      );
      return current
        .toReversed()
        .sort((left, right) => Number(right.state === "pending") - Number(left.state === "pending"))
        .map((approval) => view(approval, input.revealTypedText));
    },
  );

  return ComputerApprovals.of({ create, decide, take, cancelTask, list });
});

export const layer = Layer.effect(ComputerApprovals, make());
