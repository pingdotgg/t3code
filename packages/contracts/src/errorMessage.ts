import { mFallback } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

let resolver: MFunctionType = mFallback;

/** Clients install their UI-language resolver at startup; the server never does, so it stays English. */
export function setErrorMessageResolver(resolve: MFunctionType): void {
  resolver = resolve;
}

/** Resolves a `msg()` error message in the client's UI language, or English on the server. */
export const errorMessage: MFunctionType = (message, variables) => resolver(message, variables);
