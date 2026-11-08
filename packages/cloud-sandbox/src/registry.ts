import { createBoatApiClient } from "@t3tools/boat";
import type { CloudSandboxDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/http";
import { CloudSandboxError } from "./driver.ts";
import { createBoatCloudSandboxDriver } from "./drivers/boat/boatDriver.ts";

export const supportedCloudSandboxDrivers = [{ kind: "boat", label: "Boat.dev" }] as const;

export const createCloudSandboxDriver = Effect.fn("CloudSandboxDriverRegistry.create")(function* (
  kind: CloudSandboxDriverKind,
  options: { readonly apiKey: string; readonly httpClient?: HttpClient.HttpClient },
) {
  if (kind !== "boat")
    return yield* new CloudSandboxError({
      reason: "configuration",
      cause: new Error("Unsupported cloud sandbox provider."),
    });
  return createBoatCloudSandboxDriver(
    createBoatApiClient({ ...options, apiKey: options.apiKey.trim() }),
  );
});
