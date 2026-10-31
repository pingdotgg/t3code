import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Where `useProxy` provider instances send model traffic. */
export const ProviderProxyHost = Schema.Literals(["off", "managed", "external"]);
export type ProviderProxyHost = typeof ProviderProxyHost.Type;

/** Settings saved before `host` existed meant "external" whenever a URL was set. */
export const providerProxyHost = (proxy: {
  readonly host?: ProviderProxyHost | undefined;
  readonly url: string;
}): ProviderProxyHost => proxy.host ?? (proxy.url === "" ? "off" : "external");

/** Whether `useProxy` instances have somewhere to send requests. */
export const providerProxyConfigured = (proxy: {
  readonly host?: ProviderProxyHost | undefined;
  readonly url: string;
}): boolean => {
  const host = providerProxyHost(proxy);
  return host === "managed" || (host === "external" && proxy.url !== "");
};

/** The CLIProxyAPI process this environment runs when the host is `managed`. */
export const ProviderProxyRuntimeStatus = Schema.Struct({
  status: Schema.Literals(["stopped", "installing", "starting", "running", "error"]),
  version: Schema.optionalKey(TrimmedNonEmptyString),
  message: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProviderProxyRuntimeStatus = typeof ProviderProxyRuntimeStatus.Type;

export const ProviderProxyAccount = Schema.Struct({
  /** The proxy's credential file name; account operations address it. */
  name: TrimmedNonEmptyString,
  /** The proxy's provider id, such as `claude` or `codex`. */
  provider: TrimmedNonEmptyString,
  email: Schema.optionalKey(TrimmedNonEmptyString),
  state: Schema.Literals(["active", "disabled", "cooldown", "error"]),
  statusMessage: Schema.optionalKey(TrimmedNonEmptyString),
  /** When a cooling-down account becomes usable again. */
  retryAt: Schema.optionalKey(IsoDateTime),
});
export type ProviderProxyAccount = typeof ProviderProxyAccount.Type;

export const ProviderProxyState = Schema.Struct({
  runtime: ProviderProxyRuntimeStatus,
  /** `null` when this environment has no management access to a proxy. */
  accounts: Schema.NullOr(Schema.Array(ProviderProxyAccount)),
  accountsError: Schema.optionalKey(Schema.String),
});
export type ProviderProxyState = typeof ProviderProxyState.Type;

export const ProviderProxyLoginProvider = Schema.Literals(["claude", "codex"]);
export type ProviderProxyLoginProvider = typeof ProviderProxyLoginProvider.Type;

export const ProviderProxyStartLoginInput = Schema.Struct({
  provider: ProviderProxyLoginProvider,
});
export const ProviderProxyLogin = Schema.Struct({
  state: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
});
export type ProviderProxyLogin = typeof ProviderProxyLogin.Type;

export const ProviderProxyLoginStatusInput = Schema.Struct({ state: TrimmedNonEmptyString });
export const ProviderProxyLoginStatus = Schema.Struct({
  status: Schema.Literals(["wait", "ok", "error"]),
  message: Schema.optionalKey(Schema.String),
});
export type ProviderProxyLoginStatus = typeof ProviderProxyLoginStatus.Type;

/** The URL the browser landed on after signing in; it carries the code and state. */
export const ProviderProxyCompleteLoginInput = Schema.Struct({
  state: TrimmedNonEmptyString,
  redirectUrl: TrimmedNonEmptyString,
});

export const ProviderProxySetAccountDisabledInput = Schema.Struct({
  name: TrimmedNonEmptyString,
  disabled: Schema.Boolean,
});

export const ProviderProxyRemoveAccountInput = Schema.Struct({ name: TrimmedNonEmptyString });

export class ProviderProxyError extends Schema.TaggedError<ProviderProxyError>()(
  "ProviderProxyError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
