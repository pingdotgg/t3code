import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export interface ProviderTextDeltaUpdate {
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly completed: boolean;
}

export interface ProviderTextDeltaCoalescer {
  readonly append: (input: {
    readonly turnId: string;
    readonly itemId: string;
    readonly delta: string;
  }) => Effect.Effect<void>;
  readonly complete: (input: {
    readonly turnId: string;
    readonly itemId: string;
    readonly finalText?: string;
    readonly emitEmpty?: boolean;
  }) => Effect.Effect<string>;
  readonly flushTurn: (turnId: string) => Effect.Effect<void>;
}

interface BufferedProviderText {
  readonly turnId: string;
  readonly itemId: string;
  readonly text: string;
  readonly dirty: boolean;
}

function providerTextBufferKey(turnId: string, itemId: string): string {
  return `${turnId}\u0000${itemId}`;
}

export const makeProviderTextDeltaCoalescer = Effect.fn("makeProviderTextDeltaCoalescer")(
  function* (input: {
    readonly flushIntervalMs: number;
    readonly emit: (update: ProviderTextDeltaUpdate) => Effect.Effect<void>;
  }): Effect.fn.Return<ProviderTextDeltaCoalescer, never, Scope.Scope> {
    const buffered = yield* Ref.make(new Map<string, BufferedProviderText>());
    const flushScheduled = yield* Ref.make(false);
    const flushLock = yield* Semaphore.make(1);
    const coalescerScope = yield* Effect.scope;

    const drain = (options: {
      readonly predicate: (message: BufferedProviderText) => boolean;
      readonly completed: boolean;
      readonly onlyDirty: boolean;
      readonly releaseSchedule?: boolean;
    }) =>
      flushLock.withPermit(
        Effect.gen(function* () {
          const current = yield* Ref.get(buffered);
          const updates: Array<ProviderTextDeltaUpdate> = [];
          for (const message of current.values()) {
            if (!options.predicate(message) || (options.onlyDirty && !message.dirty)) {
              continue;
            }
            updates.push({
              turnId: message.turnId,
              itemId: message.itemId,
              text: message.text,
              completed: options.completed,
            });
          }
          const emitUpdates = Effect.forEach(updates, input.emit, { discard: true });
          yield* options.releaseSchedule === true
            ? emitUpdates.pipe(Effect.ensuring(Ref.set(flushScheduled, false)))
            : emitUpdates;
          yield* Ref.update(buffered, (current) => {
            const next = new Map(current);
            for (const [key, message] of current) {
              if (!options.predicate(message) || (options.onlyDirty && !message.dirty)) {
                continue;
              }
              if (options.completed) {
                next.delete(key);
              } else {
                next.set(key, { ...message, dirty: false });
              }
            }
            return next;
          });
        }),
      );

    const flushDirty = drain({
      predicate: () => true,
      completed: false,
      onlyDirty: true,
      releaseSchedule: true,
    });

    return {
      append: ({ turnId, itemId, delta }) =>
        delta.length === 0
          ? Effect.void
          : Effect.uninterruptible(
              Effect.gen(function* () {
                const shouldSchedule = yield* flushLock.withPermit(
                  Effect.gen(function* () {
                    yield* Ref.update(buffered, (current) => {
                      const key = providerTextBufferKey(turnId, itemId);
                      const existing = current.get(key);
                      const next = new Map(current);
                      next.set(key, {
                        turnId,
                        itemId,
                        text: `${existing?.text ?? ""}${delta}`,
                        dirty: true,
                      });
                      return next;
                    });
                    return yield* Ref.modify(flushScheduled, (scheduled) => [!scheduled, true]);
                  }),
                );
                if (shouldSchedule) {
                  yield* Effect.sleep(Duration.millis(Math.max(1, input.flushIntervalMs))).pipe(
                    Effect.andThen(flushDirty),
                    Effect.interruptible,
                    Effect.forkIn(coalescerScope),
                  );
                }
              }),
            ),
      complete: ({ turnId, itemId, finalText, emitEmpty = true }) =>
        flushLock.withPermit(
          Effect.gen(function* () {
            const key = providerTextBufferKey(turnId, itemId);
            const existing = (yield* Ref.get(buffered)).get(key);
            const text = finalText !== undefined ? finalText : (existing?.text ?? "");
            if (emitEmpty || text.length > 0) {
              yield* input.emit({ turnId, itemId, text, completed: true });
            }
            yield* Ref.update(buffered, (current) => {
              const next = new Map(current);
              next.delete(key);
              return next;
            });
            return text;
          }),
        ),
      flushTurn: (turnId) =>
        drain({
          predicate: (message) => message.turnId === turnId,
          completed: true,
          onlyDirty: false,
        }),
    };
  },
);
