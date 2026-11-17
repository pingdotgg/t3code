import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BoatCloudSetup, BoatCloudStart } from "./boatCloud.ts";

/**
 * boxd cloud runs agents on boxd (boxd.sh) machines, the same way Boat cloud runs them on
 * Boat VMs: each machine runs its own T3 server and clients pair with it over its public URL.
 * Starts, setup progress and sessions use Boat cloud's shapes, so clients show them the same way.
 */

const BOXD_HOST_SUFFIX = ".boxd.sh";

export function isBoxdCloudHttpBaseUrl(httpBaseUrl: string | null | undefined): boolean {
  if (!httpBaseUrl) return false;
  try {
    return new URL(httpBaseUrl).hostname.endsWith(BOXD_HOST_SUFFIX);
  } catch {
    return false;
  }
}

/** boxd wakes an asleep machine on its own when a client connects to its URL. */
export const BoxdCloudMachineState = Schema.Literals(["running", "asleep", "stopped"]);
export type BoxdCloudMachineState = typeof BoxdCloudMachineState.Type;

export const BoxdCloudMachine = Schema.Struct({
  vmId: TrimmedNonEmptyString,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.String,
  httpBaseUrl: Schema.NullOr(Schema.String),
  state: BoxdCloudMachineState,
  repositories: Schema.Array(Schema.String),
});
export type BoxdCloudMachine = typeof BoxdCloudMachine.Type;

export const BoxdCloudStatus = Schema.Struct({
  connected: Schema.Boolean,
  /** The boxd account the key belongs to. */
  account: Schema.NullOr(Schema.String),
  setup: BoatCloudSetup,
  /** Machines can start from the saved snapshot, even while setup rebuilds it. */
  snapshotReady: Schema.Boolean,
  machines: Schema.Array(BoxdCloudMachine),
  starts: Schema.Array(BoatCloudStart),
});
export type BoxdCloudStatus = typeof BoxdCloudStatus.Type;

export const BoxdCloudConnectInput = Schema.Struct({
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type BoxdCloudConnectInput = typeof BoxdCloudConnectInput.Type;

export class BoxdCloudError extends Schema.TaggedError<BoxdCloudError>()("BoxdCloudError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
