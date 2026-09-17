import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeDeviceScaleFactor = Schema.decodeUnknownOption(
  Schema.Finite.check(Schema.isGreaterThan(0)),
);

export function normalizeLinuxDeviceScaleFactor(value: unknown): number | null {
  return Option.getOrNull(decodeDeviceScaleFactor(value));
}
