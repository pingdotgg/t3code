import type { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
import * as Effect from "effect/Effect";
import { ProviderAdapterDriverCreateError } from "./adapterDriver.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";

/**
 * Keep construction in the instance scope while sharing it across concurrent
 * first uses. A failed construction, including a failed import of the
 * adapter's module, surfaces as the method's typed error and is retried on
 * the next use.
 */
export const makeLazyAdapter = <E, R>(
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  make: Effect.Effect<ProviderAdapter.ProviderAdapterV2["Service"], E, R>,
) =>
  Effect.gen(function* () {
    const adapter = yield* cacheInOwnerScope(
      make.pipe(
        Effect.catchDefect((cause) =>
          Effect.fail(
            new ProviderAdapterDriverCreateError({
              driver,
              instanceId,
              detail: "The adapter could not load.",
              cause,
            }),
          ),
        ),
      ),
    );
    return ProviderAdapter.ProviderAdapterV2.of({
      instanceId,
      driver,
      getCapabilities: () =>
        adapter.pipe(
          Effect.mapError(
            (cause) => new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver, cause }),
          ),
          Effect.flatMap((value) => value.getCapabilities()),
        ),
      planSelectionTransition: (input) =>
        adapter.pipe(
          Effect.mapError(
            (cause) => new ProviderAdapter.ProviderAdapterCapabilitiesError({ driver, cause }),
          ),
          Effect.flatMap((value) => value.planSelectionTransition(input)),
        ),
      openSession: (input) =>
        adapter.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((value) => value.openSession(input)),
        ),
    });
  });
