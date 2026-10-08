import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

const LOCATION_NAME_MAX_CHARS = 255;
const LOCATION_ADDRESS_MAX_CHARS = 2_048;

const SinglelineString = (maxLength: number) =>
  Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maxLength),
    Schema.makeFilter(
      (value) =>
        // oxlint-disable-next-line no-control-regex -- Reject control characters in geocoded fields.
        value.trim().length > 0 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value),
      {
        expected: "a non-blank single-line string",
      },
    ),
  );

/** A one-shot location snapshot supplied by a user or device. */
export const SharedLocation = Schema.Struct({
  name: SinglelineString(LOCATION_NAME_MAX_CHARS),
  address: SinglelineString(LOCATION_ADDRESS_MAX_CHARS),
  latitude: Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: -90, maximum: 90 })),
  longitude: Schema.Number.check(
    Schema.isFinite(),
    Schema.isBetween({ minimum: -180, maximum: 180 }),
  ),
  accuracy: Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  capturedAt: Schema.optionalKey(
    Schema.NullOr(
      IsoDateTime.check(
        Schema.isMaxLength(64),
        Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u),
        Schema.makeFilter((value) => Number.isFinite(Date.parse(value)), {
          expected: "a valid capture timestamp",
        }),
      ),
    ),
  ),
});
export type SharedLocation = typeof SharedLocation.Type;
