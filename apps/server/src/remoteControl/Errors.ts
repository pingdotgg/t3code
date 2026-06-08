/**
 * Remote Control launcher errors.
 *
 * Mirrors `provider/Errors.ts` style (`Schema.TaggedErrorClass` with an
 * `override get message()`), scoped to launching the real `claude` CLI in
 * Remote Control mode. T3 only LAUNCHES the official CLI — it does not build a
 * relay — so these errors describe local spawn / exit failures of that process,
 * never any networked pairing state (Anthropic owns the relay).
 *
 * @module remoteControl/Errors
 */
import * as Schema from "effect/Schema";

/**
 * ClaudeRemoteControlLaunchError - The `claude` Remote Control process could
 * not be spawned (binary missing, permission denied, bad cwd, etc.).
 */
export class ClaudeRemoteControlLaunchError extends Schema.TaggedErrorClass<ClaudeRemoteControlLaunchError>()(
  "ClaudeRemoteControlLaunchError",
  {
    binaryPath: Schema.String,
    mode: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to launch Claude Remote Control (${this.mode}) via '${this.binaryPath}': ${this.detail}`;
  }
}

/**
 * ClaudeRemoteControlExitError - The `claude` Remote Control process started
 * but exited with a non-zero status.
 */
export class ClaudeRemoteControlExitError extends Schema.TaggedErrorClass<ClaudeRemoteControlExitError>()(
  "ClaudeRemoteControlExitError",
  {
    binaryPath: Schema.String,
    mode: Schema.String,
    exitCode: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Claude Remote Control (${this.mode}) exited with code ${this.exitCode}`;
  }
}

export type ClaudeRemoteControlError =
  | ClaudeRemoteControlLaunchError
  | ClaudeRemoteControlExitError;
