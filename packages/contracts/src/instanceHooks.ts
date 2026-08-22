import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// ── Instance lifecycle hooks ─────────────────────────────────────────
//
// A VM management solution that hosts a T3 server can set `startHookUrl` and
// `stopHookUrl` in the server's settings so users manage the instance from
// T3 Code instead of opening the management app. Clients cache the server
// settings with the rest of the server config, which keeps the start hook
// reachable while the instance is off.
//
// Start hook (client → management endpoint): `POST <startHookUrl>` with no
// body. A `200` carries `StartHookPollState`; poll `poll_url` every
// `retry_secs` seconds until a `204`, then run the normal connect flow. A
// `400` carries `StartHookForm`; render the components, POST back a JSON
// array of the resolved component values, and expect `StartHookPollState`.
//
// Stop hook (server → management endpoint): `DELETE <stopHookUrl>`. A `204`
// means the instance is stopping. A `404` means the hook no longer exists;
// the server clears the setting so clients drop the stop control.

export const StartHookPollState = Schema.Struct({
  poll_url: TrimmedNonEmptyString,
  retry_secs: Schema.Number,
});
export type StartHookPollState = typeof StartHookPollState.Type;

/** Informational text rendered above or between input components. */
export const StartHookTextResponse = Schema.Struct({
  text: Schema.String,
});
export type StartHookTextResponse = typeof StartHookTextResponse.Type;

export const StartHookSelectValue = Schema.Struct({
  userTitle: Schema.String,
  userDescription: Schema.String,
  content: Schema.String,
});
export type StartHookSelectValue = typeof StartHookSelectValue.Type;

export const StartHookSelectComponent = Schema.Struct({
  type: Schema.Literal("select"),
  title: Schema.String,
  description: Schema.String,
  defaultValue: Schema.String,
  values: Schema.Array(StartHookSelectValue),
});
export type StartHookSelectComponent = typeof StartHookSelectComponent.Type;

export const StartHookTextComponent = Schema.Struct({
  type: Schema.Literal("text"),
  title: Schema.String,
  description: Schema.String,
  regex: Schema.String,
  validationError: Schema.String,
});
export type StartHookTextComponent = typeof StartHookTextComponent.Type;

export const StartHookFormComponent = Schema.Union([
  StartHookSelectComponent,
  StartHookTextComponent,
  StartHookTextResponse,
]);
export type StartHookFormComponent = typeof StartHookFormComponent.Type;

export const StartHookForm = Schema.Struct({
  button_text: Schema.String,
  components: Schema.Array(StartHookFormComponent),
});
export type StartHookForm = typeof StartHookForm.Type;

// ── Stop hook RPC shapes ─────────────────────────────────────────────

export const ServerStopHookOutcome = Schema.Literals(["stopped", "gone"]);
export type ServerStopHookOutcome = typeof ServerStopHookOutcome.Type;

export const ServerStopHookResult = Schema.Struct({
  outcome: ServerStopHookOutcome,
});
export type ServerStopHookResult = typeof ServerStopHookResult.Type;

export class ServerStopHookNotConfiguredError extends Schema.TaggedErrorClass<ServerStopHookNotConfiguredError>()(
  "ServerStopHookNotConfiguredError",
  {},
) {
  override get message(): string {
    return "No stop hook is configured on this server.";
  }
}

export class ServerStopHookInvalidUrlError extends Schema.TaggedErrorClass<ServerStopHookInvalidUrlError>()(
  "ServerStopHookInvalidUrlError",
  {
    /** Parsed scheme of the rejected URL, or null when it did not parse. */
    protocol: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.protocol === null
      ? "The configured stop hook is not a valid URL."
      : `The configured stop hook uses the unsupported scheme ${this.protocol}.`;
  }
}

export class ServerStopHookRequestError extends Schema.TaggedErrorClass<ServerStopHookRequestError>()(
  "ServerStopHookRequestError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The stop hook request failed.";
  }
}

export class ServerStopHookUnexpectedStatusError extends Schema.TaggedErrorClass<ServerStopHookUnexpectedStatusError>()(
  "ServerStopHookUnexpectedStatusError",
  {
    status: Schema.Number,
  },
) {
  override get message(): string {
    return `The stop hook responded with unexpected status ${this.status}.`;
  }
}

export const ServerStopHookError = Schema.Union([
  ServerStopHookNotConfiguredError,
  ServerStopHookInvalidUrlError,
  ServerStopHookRequestError,
  ServerStopHookUnexpectedStatusError,
]);
export type ServerStopHookError = typeof ServerStopHookError.Type;
