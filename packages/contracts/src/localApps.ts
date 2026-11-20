import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const LocalApp = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  /** The `.app` bundle on the environment's machine. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  bundleId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  running: Schema.Boolean,
});
export type LocalApp = typeof LocalApp.Type;

export const LocalAppsListInput = Schema.Struct({});
export type LocalAppsListInput = typeof LocalAppsListInput.Type;

/** Running apps first. Empty where the machine has no app catalog this server can read. */
export const LocalAppsListResult = Schema.Struct({
  apps: Schema.Array(LocalApp),
});
export type LocalAppsListResult = typeof LocalAppsListResult.Type;
