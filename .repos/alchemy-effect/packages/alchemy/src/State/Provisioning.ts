import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AlchemyContext } from "../AlchemyContext.ts";
import * as Interaction from "../Interaction.ts";
import { StateStoreError } from "./State.ts";

/**
 * What every plugin state store does when it's missing or outdated, so the
 * policy lives in one place: create on first use and upgrade on `--yes` or
 * confirmation. In CI, only `--yes` does either.
 */

const CI = Config.Boolean("CI").pipe(Config.withDefault(false));

/** A logical store name; stores derive physical names from it. */
export const storeName = (name: string) =>
  /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/.test(name)
    ? Effect.succeed(name)
    : Effect.fail(
        new StateStoreError({
          message: `Invalid state store name '${name}': use 1-20 lowercase letters, digits and hyphens.`,
        }),
      );

export interface StoreRef {
  readonly backend: string;
  readonly name?: string;
  /** e.g. `Cloudflare State Store 'alchemy-state-store'`. */
  readonly label: string;
  /**
   * Only the stack's config describes this store, e.g. a custom Worker or
   * bucket name or a pinned account, so `--backend` can't address it.
   */
  readonly configured?: boolean;
}

const required = (store: StoreRef, action: "bootstrap" | "upgrade", problem: string) => {
  const command = store.configured
    ? "alchemy state bootstrap"
    : `alchemy state bootstrap --backend ${store.backend}${store.name ? ` --name ${store.name}` : ""}`;
  return new StateStoreError({
    message: `${store.label} ${problem}. Run '${command} --profile <your-ci-profile>' first, or pass --yes.`,
    requires: { action, command },
  });
};

/** Deploy a missing (or half-bootstrapped) store; in CI, only with `--yes`. */
export const deployMissing = <A, E, R>(
  store: StoreRef & { readonly incomplete?: boolean },
  deploy: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const problem = store.incomplete ? "has an unfinished bootstrap" : "not found";
    const context = yield* Effect.serviceOption(AlchemyContext);
    const yes = Option.isSome(context) && context.value.updateStateStore;
    if (!yes && (yield* CI)) return yield* required(store, "bootstrap", problem);
    const interaction = yield* Effect.serviceOption(Interaction.Interaction);
    if (Option.isSome(interaction)) {
      yield* interaction.value.output.info(`${store.label} ${problem}; deploying it.`);
    }
    return yield* deploy;
  });

/** Upgrade an outdated store with `--yes` or on confirmation; in CI, only with `--yes`. */
export const upgradeOutdated = <A, E, R>(
  store: StoreRef & { readonly observed: number | undefined; readonly expected: number },
  upgrade: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const problem = `is out of date (expected v${store.expected}, observed v${store.observed ?? "unknown"})`;
    const context = yield* Effect.serviceOption(AlchemyContext);
    if (Option.isSome(context) && context.value.updateStateStore) return yield* upgrade;
    if (yield* CI) return yield* required(store, "upgrade", problem);
    const interaction = yield* Effect.serviceOption(Interaction.Interaction);
    const confirmed = Option.isSome(interaction)
      ? yield* interaction.value.prompt
          .confirm({ message: `${store.label} ${problem}`, initialValue: true })
          .pipe(Effect.orElseSucceed(() => false))
      : false;
    return confirmed ? yield* upgrade : yield* required(store, "upgrade", problem);
  });
