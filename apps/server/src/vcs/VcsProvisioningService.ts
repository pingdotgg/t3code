import { Context, Effect, Layer } from "effect";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import { VcsDriverRegistry } from "./VcsDriverRegistry.ts";

export interface VcsProvisioningServiceShape {
  readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
}

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  VcsProvisioningServiceShape
>()("t3/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "A concrete VCS driver kind is required for repository provisioning.",
      }),
    );
  }
  return Effect.succeed(kind);
}

export const make = Effect.fn("makeVcsProvisioningService")(function* () {
  const registry = yield* VcsDriverRegistry;

  const initRepository: VcsProvisioningServiceShape["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    const driver = yield* registry.get(kind);
    return yield* driver.initRepository(input);
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make());
