import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

/**
 * What `startLocalServerAdvertisement` published for this process. It exists so
 * `/api/auth/local-pair` can answer two questions without re-deriving them:
 * whether local discovery is active at all, and which instance/runtime
 * directory the caller must prove against.
 *
 * `null` (the initial value) means the endpoint is closed. That is the
 * fail-closed default for every server that is not a headless, Linux,
 * loopback-only `t3 serve`.
 */
export interface LocalServerDiscoveryRecord {
  readonly instanceId: string;
  /** Canonical loopback base URL, e.g. `http://127.0.0.1:3773/`. */
  readonly httpBaseUrl: string;
  readonly platform: NodeJS.Platform;
  readonly xdgRuntimeDirectory: string | undefined;
}

export class LocalServerDiscoveryState extends Context.Service<
  LocalServerDiscoveryState,
  {
    readonly current: Effect.Effect<LocalServerDiscoveryRecord | null>;
    readonly activate: (record: LocalServerDiscoveryRecord) => Effect.Effect<void>;
    readonly deactivate: Effect.Effect<void>;
  }
>()("t3/localServerDiscoveryState") {}

const make = Effect.gen(function* () {
  const state = yield* Ref.make<LocalServerDiscoveryRecord | null>(null);

  return {
    current: Ref.get(state),
    activate: (record) => Ref.set(state, record),
    deactivate: Ref.set(state, null),
  } satisfies LocalServerDiscoveryState["Service"];
});

export const layer = Layer.effect(LocalServerDiscoveryState, make);
