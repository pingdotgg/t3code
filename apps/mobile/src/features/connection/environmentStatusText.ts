import {
  connectionErrorText,
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { MarkedText } from "@t3tools/client-runtime/errors";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";

/** Connection error text from runtime state, in the current language when the error is marked. */
export function runtimeConnectionErrorText(
  state: { readonly connectionError: string | null; readonly i18nConnectionError?: MarkedText },
  resolve: MessageResolver = m,
): string | null {
  return connectionErrorText(
    {
      error: state.connectionError,
      ...(state.i18nConnectionError === undefined ? {} : { i18nError: state.i18nConnectionError }),
    },
    resolve,
  );
}

/** Status for an environment that holds no connection: its switch is off, or a Focus pauses it. */
export function offStatusText(
  environment: { readonly isPausedByFocus: boolean },
  resolve: MessageResolver = m,
): string {
  return environment.isPausedByFocus
    ? resolve(
        msg("Paused by Focus", { $context: "an iOS Focus filter leaves this environment out" }),
      )
    : resolve(msg("Off", { $context: "environment is switched off" }));
}

/** A paused environment keeps the user's switch on, drawn dimmed. */
export const PAUSED_SWITCH_OPACITY = 0.4;

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  resolve: MessageResolver = m,
): string {
  const error = connectionErrorText(connection, resolve);
  return connection.phase === "unsupported" && error !== null
    ? error
    : connectionStatusText(connection, resolve);
}
