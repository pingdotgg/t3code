import { TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

const CODEX_INTERRUPT_THREAD_READ_TIMEOUT = "2 seconds" as const;

type CodexTurnOrderingCandidate = Pick<
  EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number],
  "startedAt"
>;

export function shouldReplaceActiveCodexTurnCandidate(
  candidate: CodexTurnOrderingCandidate,
  selected: CodexTurnOrderingCandidate | undefined,
): boolean {
  if (selected === undefined) {
    return true;
  }

  // When either timestamp is absent, provider response order is authoritative.
  // The caller scans in response order, so the later candidate replaces the selection.
  if (candidate.startedAt == null || selected.startedAt == null) {
    return true;
  }

  return candidate.startedAt >= selected.startedAt;
}

export function findActiveCodexTurnId(response: {
  readonly thread: Pick<EffectCodexSchema.V2ThreadReadResponse["thread"], "turns">;
}): TurnId | undefined {
  let activeTurn: EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"][number] | undefined;
  for (const turn of response.thread.turns) {
    if (turn.status !== "inProgress") {
      continue;
    }
    if (shouldReplaceActiveCodexTurnCandidate(turn, activeTurn)) {
      activeTurn = turn;
    }
  }
  return activeTurn === undefined ? undefined : TurnId.make(activeTurn.id);
}

export function resolveCodexInterruptTurnId<E>(input: {
  readonly providerThreadId: string;
  readonly requestedTurnId: TurnId | undefined;
  readonly readSessionActiveTurnId: Effect.Effect<TurnId | undefined>;
  readonly readThread: Effect.Effect<Parameters<typeof findActiveCodexTurnId>[0], E>;
}): Effect.Effect<TurnId | undefined> {
  if (input.requestedTurnId !== undefined) {
    return Effect.succeed(input.requestedTurnId);
  }

  return input.readThread.pipe(
    Effect.timeout(CODEX_INTERRUPT_THREAD_READ_TIMEOUT),
    Effect.map(findActiveCodexTurnId),
    Effect.tapError((cause) =>
      Effect.logWarning("Failed to resolve active Codex turn before interrupt.", {
        providerThreadId: input.providerThreadId,
        cause,
      }),
    ),
    // A failed lookup can still use the locally projected id. A successful
    // lookup with no active turn must not revive a stale local id.
    Effect.catchDefect((defect) =>
      Effect.logWarning("Failed to resolve active Codex turn before interrupt.", {
        providerThreadId: input.providerThreadId,
        cause: defect,
      }).pipe(Effect.andThen(input.readSessionActiveTurnId)),
    ),
    Effect.catch(() => input.readSessionActiveTurnId),
  );
}
