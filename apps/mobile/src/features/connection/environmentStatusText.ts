import {
  connectionErrorText,
  connectionStatusText,
  type EnvironmentConnectionPresentation,
} from "@t3tools/client-runtime/connection";
import type { MarkedText } from "@t3tools/client-runtime/errors";

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

export function environmentStatusText(
  connection: EnvironmentConnectionPresentation,
  resolve: MessageResolver = m,
): string {
  const error = connectionErrorText(connection, resolve);
  return connection.phase === "unsupported" && error !== null
    ? error
    : connectionStatusText(connection, resolve);
}
