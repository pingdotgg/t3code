import { Schema } from "effect";

export const CanonicalJsonValueSchema = Schema.Json;
export type CanonicalJsonValue = typeof CanonicalJsonValueSchema.Type;

export const CanonicalJsonObjectSchema = Schema.Record(Schema.String, CanonicalJsonValueSchema);
export type CanonicalJsonObject = typeof CanonicalJsonObjectSchema.Type;
