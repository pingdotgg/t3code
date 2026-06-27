import { canonicalJsonError, hashArgs } from "./t3work-sdk.canonicalJson.ts";
import { JournalSchemaError, JournalSerializeError } from "./t3work-sdk.errors.ts";
import type { JournalSink } from "./t3work-sdk.journalStore.ts";
import type { JournalEntry } from "./t3work-sdk.journalReader.ts";
import { assertJournalMatch, gapDrift } from "./t3work-sdk.replayDrift.ts";
import type * as T from "./t3work-sdk.types.ts";

export interface DurablePrimitiveSeat {
  readonly journal: ReadonlyMap<number, JournalEntry>;
  readonly writer: JournalSink;
  readonly filePath?: string | undefined;
  readonly nowIso: () => string;
  readonly maxRecordedSeq: number;
  readonly isBlackBoxed: () => boolean;
  readonly takeSeq: () => number;
}

export function createDurableCallPrimitive(seat: DurablePrimitiveSeat) {
  const decodeRecorded = async <R>(
    call: T.PrimitiveCall<R>,
    recorded: unknown,
    atSeq: number,
  ): Promise<R> => {
    if (call.decodeRecorded === undefined) return recorded as R;
    try {
      return await call.decodeRecorded(recorded);
    } catch (error) {
      throw new JournalSchemaError({
        seq: atSeq,
        kind: call.kind,
        refId: call.refId,
        cause: error,
      });
    }
  };

  return async <R>(call: T.PrimitiveCall<R>): Promise<R> => {
    if (seat.isBlackBoxed()) return await call.exec();
    const currentSeq = seat.takeSeq();
    const argsHash = hashArgs(call.args);
    const isNever = call.replay === "never";
    const recorded = seat.journal.get(currentSeq);

    if (recorded !== undefined) {
      assertJournalMatch(currentSeq, recorded, call.kind, call.refId, argsHash, seat.filePath);
      if (isNever) return await call.exec();
      return await decodeRecorded(call, recorded.result, currentSeq);
    }

    if (currentSeq <= seat.maxRecordedSeq)
      gapDrift(currentSeq, call.kind, call.refId, seat.filePath);

    const result = await call.exec();
    const startedAt = seat.nowIso();
    const endedAt = seat.nowIso();
    const callId = `${currentSeq}:${call.kind}:${call.refId}`;
    const baseEntry = { seq: currentSeq, callId, refId: call.refId, argsHash, startedAt, endedAt };

    if (isNever) {
      seat.writer.append({ ...baseEntry, kind: "script-never", result: undefined });
      return result;
    }

    const serializeError = result === undefined ? undefined : canonicalJsonError(result);
    if (serializeError !== undefined) {
      throw new JournalSerializeError({
        seq: currentSeq,
        kind: call.kind,
        refId: call.refId,
        cause: serializeError,
      });
    }
    seat.writer.append({ ...baseEntry, kind: call.kind, result });
    return result;
  };
}

export function createDurableCallDeterministic(seat: DurablePrimitiveSeat) {
  return <R extends number | string>(kind: "now" | "random" | "uuid", exec: () => R): R => {
    if (seat.isBlackBoxed()) return exec();
    const at = seat.takeSeq();
    const argsHash = hashArgs(null);
    const recorded = seat.journal.get(at);
    if (recorded !== undefined) {
      assertJournalMatch(at, recorded, kind, kind, argsHash, seat.filePath);
      return recorded.result as R;
    }
    if (at <= seat.maxRecordedSeq) gapDrift(at, kind, kind, seat.filePath);
    const result = exec();
    const ts = seat.nowIso();
    seat.writer.append({
      seq: at,
      callId: `${at}:${kind}:${kind}`,
      kind,
      refId: kind,
      argsHash,
      result,
      startedAt: ts,
      endedAt: ts,
    });
    return result;
  };
}
