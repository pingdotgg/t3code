/**
 * scopedSafeTeardown — run a scope-requiring effect so that finalizer
 * failures during scope close cannot override the body's Exit.
 *
 * Motivation
 * ----------
 * The obvious pattern is `body.pipe(Effect.scoped)`: provide a fresh
 * Scope, run the body, close the scope with the body's Exit. If a
 * finalizer (e.g. `ChildProcess.kill` from an effect-codex-app-server
 * spawn) dies during that close, the combined Exit becomes the
 * finalizer's defect — even when the body already succeeded.
 *
 * Concretely this bit us in the Codex provider probe: a successful
 * `initialize` → `account/read` → `skills/list` → `model/list`
 * round-trip produced a `CodexAppServerProviderSnapshot`, but the
 * `Layer.build(CodexClient.layerCommand(...))` finalizer then failed to
 * kill the `codex app-server` subprocess with a `PlatformError`. The
 * defect bubbled past `Effect.result` in `checkCodexProviderStatus`,
 * died `refreshOneSource`, and `providersRef` never saw the snapshot.
 *
 * Strategy
 * --------
 * 1. Make a fresh scope manually.
 * 2. Run the body against that scope, capturing its Exit via
 *    `Effect.exit`.
 * 3. Close the scope, catching any cause (typed failure *or* defect)
 *    with a log.
 * 4. Replay the captured Exit so typed body failures still surface and
 *    successes still return their value.
 *
 * The helper deliberately logs teardown causes at `Warning` level —
 * silently swallowing them is dangerous because they usually indicate a
 * real bug in a downstream Layer's finalizer.
 *
 * @module provider/Layers/scopedSafeTeardown
 */
import { Effect, Exit, Scope } from "effect";

/**
 * Run `effect` with a freshly made `Scope.Scope`, guaranteeing that
 * teardown failures cannot override the body's Exit.
 *
 * Shape matches `Effect.scoped`: takes an effect whose env includes
 * `Scope.Scope`, returns one whose env excludes it.
 *
 * @param label Short label for the warning log emitted when teardown
 *   fails. Use something like `"codex-probe"`.
 */
export const scopedSafeTeardown =
  (label: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const bodyExit = yield* effect.pipe(Effect.provideService(Scope.Scope, scope), Effect.exit);
      yield* Scope.close(scope, Exit.void).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(`${label} teardown errored; preserving body result`, cause),
        ),
      );
      return yield* bodyExit;
    }) as Effect.Effect<A, E, Exclude<R, Scope.Scope>>;
