import {
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";

/** Status for an environment that holds no connection: its switch is off, or a Focus pauses it. */
export function offStatusText(environment: { readonly isPausedByFocus: boolean }): string {
  return environment.isPausedByFocus ? "Paused by Focus" : "Off";
}

/** A paused environment keeps the user's switch on, drawn dimmed. */
export const PAUSED_SWITCH_OPACITY = 0.4;

export function environmentStatusText(connection: EnvironmentConnectionPresentation): string {
  return connection.phase === "unsupported" && connection.error !== null
    ? connection.error
    : connectionStatusText(connection);
}
