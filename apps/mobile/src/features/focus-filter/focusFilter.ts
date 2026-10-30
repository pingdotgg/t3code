import { EnvironmentRegistry, type FocusAllowlist } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { NativeModule, requireOptionalNativeModule } from "expo";
import { AppState, Platform } from "react-native";

interface FocusEnvironment {
  readonly id: string;
  readonly label: string;
}

declare class T3FocusFilterModule extends NativeModule<{
  onChange: (event: { readonly environmentIds: ReadonlyArray<string> | null }) => void;
}> {
  setEnvironments(environments: ReadonlyArray<FocusEnvironment>): void;
  getAllowedEnvironmentIds(): Promise<ReadonlyArray<string> | null>;
}

const native =
  Platform.OS === "ios" ? requireOptionalNativeModule<T3FocusFilterModule>("T3FocusFilter") : null;

/** No selection, like an empty one, leaves every environment to its own switch. */
function focusAllowlist(environmentIds: ReadonlyArray<string> | null): FocusAllowlist {
  return environmentIds === null || environmentIds.length === 0
    ? null
    : new Set(environmentIds.map((environmentId) => EnvironmentId.make(environmentId)));
}

const sameEnvironments = (left: ReadonlyArray<FocusEnvironment>, right: typeof left) =>
  left.length === right.length &&
  left.every(
    (environment, index) =>
      environment.id === right[index]?.id && environment.label === right[index]?.label,
  );

const readAllowlist =
  native === null
    ? Effect.succeed<FocusAllowlist>(null)
    : Effect.tryPromise(() => native.getAllowedEnvironmentIds()).pipe(Effect.map(focusAllowlist));

/** The filter active at launch. Startup waits on it, so it gives up quickly. */
export const initialAllowlist: Effect.Effect<FocusAllowlist> = readAllowlist.pipe(
  Effect.timeout("1 second"),
  Effect.tapError((cause) => Effect.logWarning("Could not read the iOS Focus filter.", cause)),
  Effect.orElseSucceed(() => null),
);

/**
 * Keeps the iOS Focus filter and the registry in step. iOS runs the filter's `perform()` only
 * while the app process is running, so the app also rereads the filter on every return to the
 * foreground.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if (native === null) return;
    const module = native;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;

    yield* SubscriptionRef.changes(registry.entries).pipe(
      Stream.map((entries) =>
        [...entries.values()].map((entry) => ({
          id: entry.target.environmentId,
          label: entry.target.label,
        })),
      ),
      Stream.changesWith(sameEnvironments),
      Stream.runForEach((environments) => Effect.sync(() => module.setEnvironments(environments))),
      Effect.forkScoped,
    );

    const refresh = readAllowlist.pipe(
      Effect.flatMap(registry.setFocusAllowlist),
      Effect.catch((cause) => Effect.logWarning("Could not read the iOS Focus filter.", cause)),
    );
    yield* Stream.callback<"foreground" | { readonly allowlist: FocusAllowlist }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const appState = AppState.addEventListener("change", (state) => {
            if (state === "active") Queue.offerUnsafe(queue, "foreground");
          });
          const change = module.addListener("onChange", (event) => {
            Queue.offerUnsafe(queue, { allowlist: focusAllowlist(event.environmentIds) });
          });
          return () => {
            appState.remove();
            change.remove();
          };
        }),
        (remove) => Effect.sync(remove),
      ).pipe(Effect.asVoid),
    ).pipe(
      Stream.runForEach((signal) =>
        signal === "foreground" ? refresh : registry.setFocusAllowlist(signal.allowlist),
      ),
      Effect.forkScoped,
    );
  }),
);
