import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedString } from "./baseSchemas.ts";

/**
 * Configuration owned by the Oh My Pi provider driver.
 *
 * This intentionally stays tiny: T3 only locates and launches `omp acp`.
 * Oh My Pi remains authoritative for roles, model routing, fallbacks,
 * reasoning, subagents, tools, MCP, permissions, and context handling.
 */
export const OhMyPiSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type OhMyPiSettings = typeof OhMyPiSettings.Type;
