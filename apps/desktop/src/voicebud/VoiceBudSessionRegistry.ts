import type {
  VoiceBudBindRecordingInput,
  VoiceBudDraftTarget,
  VoiceBudRecordingId,
  VoiceBudRecordingStartedEvent,
  VoiceBudRequestId,
  VoiceBudResponseCode,
  VoiceBudTranscriptionEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

type RecordingBinding = {
  readonly target: VoiceBudDraftTarget;
  readonly expiresAt: number;
};

type PendingResult = {
  readonly deferred: Deferred.Deferred<boolean>;
  readonly expiresAt: number;
};

export interface VoiceBudSessionRegistryOptions {
  readonly now?: () => number;
  readonly bindingTimeoutMs?: number;
  readonly deliveryTimeoutMs?: number;
  readonly recordingTtlMs?: number;
  readonly onRecordingStarted: (event: VoiceBudRecordingStartedEvent) => Effect.Effect<void>;
  readonly onTranscription: (event: VoiceBudTranscriptionEvent) => Effect.Effect<void>;
}

/**
 * Owns the immutable recording -> composer binding independently from the
 * transport. External clients can name recordings, but only the trusted
 * renderer can select a draft destination.
 */
export class VoiceBudSessionRegistry {
  readonly #now: () => number;
  readonly #bindingTimeoutMs: number;
  readonly #deliveryTimeoutMs: number;
  readonly #recordingTtlMs: number;
  readonly #onRecordingStarted: VoiceBudSessionRegistryOptions["onRecordingStarted"];
  readonly #onTranscription: VoiceBudSessionRegistryOptions["onTranscription"];
  readonly #bindings = new Map<VoiceBudRecordingId, RecordingBinding>();
  readonly #pendingBindings = new Map<
    VoiceBudRequestId,
    { readonly recordingId: VoiceBudRecordingId; readonly result: PendingResult }
  >();
  readonly #pendingDeliveries = new Map<
    VoiceBudRequestId,
    { readonly recordingId: VoiceBudRecordingId; readonly result: PendingResult }
  >();

  constructor(options: VoiceBudSessionRegistryOptions) {
    this.#now = options.now ?? Date.now;
    this.#bindingTimeoutMs = options.bindingTimeoutMs ?? 2_000;
    this.#deliveryTimeoutMs = options.deliveryTimeoutMs ?? 5_000;
    this.#recordingTtlMs = options.recordingTtlMs ?? 10 * 60_000;
    this.#onRecordingStarted = options.onRecordingStarted;
    this.#onTranscription = options.onTranscription;
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [recordingId, binding] of this.#bindings) {
      if (binding.expiresAt <= now) {
        this.#bindings.delete(recordingId);
      }
    }
  }

  readonly begin = Effect.fn("VoiceBudSessionRegistry.begin")(function* (
    this: VoiceBudSessionRegistry,
    requestId: VoiceBudRequestId,
    recordingId: VoiceBudRecordingId,
  ): Effect.fn.Return<VoiceBudResponseCode> {
    this.#pruneExpired();
    if (
      this.#bindings.has(recordingId) ||
      Array.from(this.#pendingBindings.values()).some(
        (pending) => pending.recordingId === recordingId,
      )
    ) {
      return "duplicate_recording";
    }

    const result: PendingResult = {
      deferred: yield* Deferred.make<boolean>(),
      expiresAt: this.#now() + this.#bindingTimeoutMs,
    };
    this.#pendingBindings.set(requestId, { recordingId, result });
    const outcome = yield* Effect.exit(
      this.#onRecordingStarted({ requestId, recordingId }).pipe(
        Effect.andThen(
          Deferred.await(result.deferred).pipe(Effect.timeoutOption(this.#bindingTimeoutMs)),
        ),
      ),
    );
    const pending = this.#pendingBindings.get(requestId);
    if (pending?.result === result) {
      this.#pendingBindings.delete(requestId);
    }
    return Exit.isSuccess(outcome) && Option.getOrElse(outcome.value, () => false)
      ? "accepted"
      : "renderer_unavailable";
  });

  readonly bind = Effect.fn("VoiceBudSessionRegistry.bind")(function* (
    this: VoiceBudSessionRegistry,
    input: VoiceBudBindRecordingInput,
  ): Effect.fn.Return<boolean> {
    this.#pruneExpired();
    const pending = this.#pendingBindings.get(input.requestId);
    if (
      !pending ||
      pending.recordingId !== input.recordingId ||
      pending.result.expiresAt <= this.#now()
    ) {
      if (pending) {
        this.#pendingBindings.delete(input.requestId);
      }
      return false;
    }
    if (!(yield* Deferred.succeed(pending.result.deferred, true))) {
      this.#pendingBindings.delete(input.requestId);
      return false;
    }
    this.#pendingBindings.delete(input.requestId);
    this.#bindings.set(input.recordingId, {
      target: input.target,
      expiresAt: this.#now() + this.#recordingTtlMs,
    });
    return true;
  });

  readonly complete = Effect.fn("VoiceBudSessionRegistry.complete")(function* (
    this: VoiceBudSessionRegistry,
    deliveryId: VoiceBudRequestId,
    recordingId: VoiceBudRecordingId,
    transcript: string,
  ): Effect.fn.Return<VoiceBudResponseCode> {
    this.#pruneExpired();
    const binding = this.#bindings.get(recordingId);
    if (!binding) {
      return "unknown_recording";
    }
    if (
      Array.from(this.#pendingDeliveries.values()).some(
        (pending) => pending.recordingId === recordingId,
      )
    ) {
      return "replay";
    }

    const result: PendingResult = {
      deferred: yield* Deferred.make<boolean>(),
      expiresAt: this.#now() + this.#deliveryTimeoutMs,
    };
    this.#pendingDeliveries.set(deliveryId, { recordingId, result });
    const outcome = yield* Effect.exit(
      this.#onTranscription({
        deliveryId,
        recordingId,
        target: binding.target,
        transcript,
      }).pipe(
        Effect.andThen(
          Deferred.await(result.deferred).pipe(Effect.timeoutOption(this.#deliveryTimeoutMs)),
        ),
      ),
    );
    const pending = this.#pendingDeliveries.get(deliveryId);
    if (pending?.result === result) {
      this.#pendingDeliveries.delete(deliveryId);
    }
    // Once renderer delivery has been attempted, an absent acknowledgement is
    // ambiguous: the draft write may have succeeded before IPC was lost.
    // Consume the binding so a retry can never append the same transcript twice.
    this.#bindings.delete(recordingId);
    if (Exit.isFailure(outcome) || Option.isNone(outcome.value)) {
      return "delivery_ambiguous";
    }
    if (!outcome.value.value) {
      return "delivery_failed";
    }
    return "accepted";
  });

  readonly acknowledge = Effect.fn("VoiceBudSessionRegistry.acknowledge")(function* (
    this: VoiceBudSessionRegistry,
    deliveryId: VoiceBudRequestId,
    applied: boolean,
  ): Effect.fn.Return<boolean> {
    const pending = this.#pendingDeliveries.get(deliveryId);
    if (!pending || pending.result.expiresAt <= this.#now()) {
      if (pending) {
        this.#pendingDeliveries.delete(deliveryId);
      }
      return false;
    }
    if (!(yield* Deferred.succeed(pending.result.deferred, applied))) {
      this.#pendingDeliveries.delete(deliveryId);
      return false;
    }
    this.#pendingDeliveries.delete(deliveryId);
    return true;
  });

  readonly close = Effect.fn("VoiceBudSessionRegistry.close")(
    function* (this: VoiceBudSessionRegistry): Effect.fn.Return<void> {
      for (const { result } of this.#pendingBindings.values()) {
        yield* Deferred.succeed(result.deferred, false);
      }
      for (const { result } of this.#pendingDeliveries.values()) {
        yield* Deferred.succeed(result.deferred, false);
      }
      this.#pendingBindings.clear();
      this.#pendingDeliveries.clear();
      this.#bindings.clear();
    },
  );
}
