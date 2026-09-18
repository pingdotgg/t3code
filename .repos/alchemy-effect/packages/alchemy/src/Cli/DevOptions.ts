import * as Schema from "effect/Schema";

/** Wire format passed from the `alchemy dev` supervisor to its exec child. */
export const DevOptions = Schema.Struct({
  main: Schema.String,
  stage: Schema.String,
  envFile: Schema.OptionFromOptional(Schema.String),
  profile: Schema.optional(Schema.String),
  force: Schema.Boolean,
});

export type DevOptions = typeof DevOptions.Type;

/**
 * Exit status the exec child uses to ask the supervisor for a fresh process.
 * Bun cannot evict evaluated modules, so a stack-graph change under Bun tears
 * the generation down and exits with this code instead of reloading in place.
 */
export const DEV_RELOAD_EXIT_CODE = 75;
