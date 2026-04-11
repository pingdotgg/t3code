/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser, workspace paths in
 * a configured editor, and generic external targets through the platform's
 * default opener.
 *
 * @module Open
 */

import { type EditorId } from "@t3tools/contracts";
import { Effect, Schema, ServiceMap } from "effect";

const DesktopLauncherLaunchAttemptSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  reason: Schema.Literals(["commandNotFound", "spawnFailed", "nonZeroExit"]),
  detail: Schema.String,
  exitCode: Schema.optional(Schema.Number),
});

export class DesktopLauncherDiscoveryError extends Schema.TaggedErrorClass<DesktopLauncherDiscoveryError>()(
  "DesktopLauncherDiscoveryError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Desktop launcher discovery failed in ${this.operation}: ${this.detail}`;
  }
}

export class DesktopLauncherValidationError extends Schema.TaggedErrorClass<DesktopLauncherValidationError>()(
  "DesktopLauncherValidationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    target: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Desktop launcher validation failed in ${this.operation}: ${this.detail}`;
  }
}

export class DesktopLauncherUnknownEditorError extends Schema.TaggedErrorClass<DesktopLauncherUnknownEditorError>()(
  "DesktopLauncherUnknownEditorError",
  {
    editor: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unknown desktop editor: ${this.editor}`;
  }
}

export class DesktopLauncherCommandNotFoundError extends Schema.TaggedErrorClass<DesktopLauncherCommandNotFoundError>()(
  "DesktopLauncherCommandNotFoundError",
  {
    operation: Schema.String,
    command: Schema.String,
    target: Schema.optional(Schema.String),
    editor: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    const target = this.editor
      ? ` for editor ${this.editor}`
      : this.target
        ? ` for ${this.target}`
        : "";
    return `Desktop launcher command not found in ${this.operation}: ${this.command}${target}`;
  }
}

export class DesktopLauncherSpawnError extends Schema.TaggedErrorClass<DesktopLauncherSpawnError>()(
  "DesktopLauncherSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    target: Schema.optional(Schema.String),
    editor: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Desktop launcher failed to spawn ${this.command} in ${this.operation}`;
  }
}

export class DesktopLauncherNonZeroExitError extends Schema.TaggedErrorClass<DesktopLauncherNonZeroExitError>()(
  "DesktopLauncherNonZeroExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    args: Schema.Array(Schema.String),
    exitCode: Schema.Number,
    target: Schema.optional(Schema.String),
    editor: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Desktop launcher command exited non-zero in ${this.operation}: ${this.command} (code=${this.exitCode})`;
  }
}

export class DesktopLauncherLaunchAttemptsExhaustedError extends Schema.TaggedErrorClass<DesktopLauncherLaunchAttemptsExhaustedError>()(
  "DesktopLauncherLaunchAttemptsExhaustedError",
  {
    operation: Schema.String,
    target: Schema.optional(Schema.String),
    editor: Schema.optional(Schema.String),
    attempts: Schema.Array(DesktopLauncherLaunchAttemptSchema),
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    const subject = this.editor ? `editor ${this.editor}` : this.target ? this.target : "target";
    return `Desktop launcher exhausted all launch attempts in ${this.operation} for ${subject}`;
  }
}

export const DesktopLauncherError = Schema.Union([
  DesktopLauncherCommandNotFoundError,
  DesktopLauncherDiscoveryError,
  DesktopLauncherLaunchAttemptsExhaustedError,
  DesktopLauncherNonZeroExitError,
  DesktopLauncherSpawnError,
  DesktopLauncherUnknownEditorError,
  DesktopLauncherValidationError,
]);

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

export interface OpenApplicationInput {
  readonly name: string | ReadonlyArray<string>;
  readonly arguments?: ReadonlyArray<string>;
}

export interface OpenExternalInput {
  readonly target: string;
  readonly wait?: boolean;
  readonly background?: boolean;
  readonly newInstance?: boolean;
  readonly allowNonzeroExitCode?: boolean;
  readonly app?: OpenApplicationInput | ReadonlyArray<OpenApplicationInput>;
}

export interface DesktopLauncherShape {
  readonly getAvailableEditors: Effect.Effect<
    ReadonlyArray<EditorId>,
    DesktopLauncherDiscoveryError
  >;
  readonly openExternal: (
    input: OpenExternalInput,
  ) => Effect.Effect<
    void,
    | DesktopLauncherCommandNotFoundError
    | DesktopLauncherLaunchAttemptsExhaustedError
    | DesktopLauncherNonZeroExitError
    | DesktopLauncherSpawnError
    | DesktopLauncherValidationError
  >;
  readonly openBrowser: (
    target: string,
    options?: Omit<OpenExternalInput, "target">,
  ) => Effect.Effect<
    void,
    | DesktopLauncherCommandNotFoundError
    | DesktopLauncherLaunchAttemptsExhaustedError
    | DesktopLauncherNonZeroExitError
    | DesktopLauncherSpawnError
    | DesktopLauncherValidationError
  >;
  readonly openInEditor: (
    input: OpenInEditorInput,
  ) => Effect.Effect<
    void,
    | DesktopLauncherCommandNotFoundError
    | DesktopLauncherLaunchAttemptsExhaustedError
    | DesktopLauncherNonZeroExitError
    | DesktopLauncherSpawnError
    | DesktopLauncherUnknownEditorError
    | DesktopLauncherValidationError
  >;
}

export class DesktopLauncher extends ServiceMap.Service<DesktopLauncher, DesktopLauncherShape>()(
  "t3/desktop-launcher",
) {}
