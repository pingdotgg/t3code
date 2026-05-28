import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const decodeJsonString = Schema.decodeEffect(Schema.UnknownFromJsonString);
const encodeJsonValue = Schema.encodeEffect(Schema.UnknownFromJsonString);

export const parseJsonString = <A>(value: string) =>
  decodeJsonString(value).pipe(Effect.map((decoded) => decoded as A));

export const stringifyJsonValue = (value: unknown) => encodeJsonValue(value);
