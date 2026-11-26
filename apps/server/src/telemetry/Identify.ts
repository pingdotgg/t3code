import * as Schema from "effect/Schema";

/** Who an install belongs to. Hyakki never sends it anywhere; the shape stays for its callers. */
export const TelemetryOwnerSource = Schema.Literals(["connect", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  readonly ownerId: string;
}
