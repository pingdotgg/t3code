import * as Schema from "effect/Schema";

export const JSONObject = Schema.Record(Schema.String, Schema.Json);
