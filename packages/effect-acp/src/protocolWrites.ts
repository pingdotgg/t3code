import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";

import * as AcpError from "./errors.ts";

export interface AcpOutgoingWrite {
  readonly acknowledgement?: Deferred.Deferred<void, AcpError.AcpError>;
  readonly payload: string | Uint8Array;
}

export interface AcpOutgoingWriterState {
  readonly outstandingAcknowledgements: ReadonlySet<Deferred.Deferred<void, AcpError.AcpError>>;
  readonly intentionalEnd: boolean;
  readonly terminalError?: AcpError.AcpError;
}

type OutgoingQueue = Queue.Queue<AcpOutgoingWrite, AcpError.AcpError | Cause.Done<void>>;
type WriterState = Ref.Ref<AcpOutgoingWriterState>;

// The writer's acknowledgement bookkeeping. Each helper settles the deferreds
// tracked in writer state so `offerOutgoing` never waits on a write the
// transport has already abandoned.
export const failOutgoingWrites = (
  outgoingWriterState: WriterState,
  outgoing: OutgoingQueue,
  error: AcpError.AcpError,
) =>
  Ref.modify(outgoingWriterState, (state) => {
    const terminalError = state.terminalError ?? error;
    return [
      [terminalError, state.outstandingAcknowledgements] as const,
      {
        ...state,
        terminalError,
        outstandingAcknowledgements: new Set<Deferred.Deferred<void, AcpError.AcpError>>(),
      },
    ] as const;
  }).pipe(
    Effect.flatMap((acknowledgements) =>
      Effect.forEach(
        acknowledgements[1],
        (acknowledgement) => Deferred.fail(acknowledgement, acknowledgements[0]),
        { concurrency: "unbounded", discard: true },
      ),
    ),
    Effect.andThen(Queue.fail(outgoing, error)),
    Effect.asVoid,
  );

export const completeOutgoingWrites = (outgoingWriterState: WriterState) =>
  Ref.modify(outgoingWriterState, (state) => {
    return [
      state.outstandingAcknowledgements,
      {
        ...state,
        outstandingAcknowledgements: new Set<Deferred.Deferred<void, AcpError.AcpError>>(),
      },
    ] as const;
  }).pipe(
    Effect.flatMap((acknowledgements) =>
      Effect.forEach(
        acknowledgements,
        (acknowledgement) => Deferred.succeed(acknowledgement, undefined),
        { concurrency: "unbounded", discard: true },
      ),
    ),
    Effect.asVoid,
  );

export const acknowledgeOutgoingWrite = (
  outgoingWriterState: WriterState,
  acknowledgement: Deferred.Deferred<void, AcpError.AcpError>,
) =>
  Ref.update(outgoingWriterState, (state) => {
    const updated = new Set(state.outstandingAcknowledgements);
    updated.delete(acknowledgement);
    return { ...state, outstandingAcknowledgements: updated };
  }).pipe(Effect.andThen(Deferred.succeed(acknowledgement, undefined)), Effect.asVoid);
