import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

const INITIAL_RUN_ID = "startup";

const randomHexString = (length: number): Effect.Effect<string> =>
  Effect.gen(function* () {
    let value = "";
    while (value.length < length) {
      value += (yield* Random.nextUUIDv4).replace(/-/g, "");
    }
    return value.slice(0, length);
  });

export interface DesktopRunShape {
  readonly id: Effect.Effect<string>;
  readonly refreshId: Effect.Effect<string>;
  readonly logInfo: (message: string, annotations?: Record<string, unknown>) => Effect.Effect<void>;
  readonly logWarning: (
    message: string,
    annotations?: Record<string, unknown>,
  ) => Effect.Effect<void>;
  readonly logError: (
    message: string,
    annotations?: Record<string, unknown>,
  ) => Effect.Effect<void>;
}

export class DesktopRun extends Context.Service<DesktopRun, DesktopRunShape>()("t3/desktop/Run") {}

const make = Effect.gen(function* () {
  const idRef = yield* Ref.make(INITIAL_RUN_ID);

  const annotate = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    annotations?: Record<string, unknown>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const runId = yield* Ref.get(idRef);
      return yield* effect.pipe(
        Effect.annotateLogs({
          scope: "desktop",
          runId,
          ...annotations,
        }),
      );
    });

  return DesktopRun.of({
    id: Ref.get(idRef),
    refreshId: Effect.gen(function* () {
      const runId = yield* randomHexString(12);
      yield* Ref.set(idRef, runId);
      return runId;
    }),
    logInfo: (message, annotations) => annotate(Effect.logInfo(message), annotations),
    logWarning: (message, annotations) => annotate(Effect.logWarning(message), annotations),
    logError: (message, annotations) => annotate(Effect.logError(message), annotations),
  });
});

export const layer = Layer.effect(DesktopRun, make);
