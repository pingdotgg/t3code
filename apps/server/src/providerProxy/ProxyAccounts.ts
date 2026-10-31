/** The proxy's pooled accounts, through CLIProxyAPI's `/v0/management` API. */
import {
  providerProxyHost,
  ProviderProxyError,
  type ProviderProxyAccount,
  type ProviderProxyLogin,
  type ProviderProxyLoginProvider,
  type ProviderProxyLoginStatus,
  type ProviderProxyRuntimeStatus,
  type ProviderProxyState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import { resolveProxyManagement, type ProxyManagementEndpoint } from "./effectiveProxy.ts";
import * as ManagedProviderProxy from "./ManagedProviderProxy.ts";

const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const AuthFile = Schema.Struct({
  name: Schema.String,
  provider: OptionalText,
  type: OptionalText,
  email: OptionalText,
  account: OptionalText,
  label: OptionalText,
  status: OptionalText,
  status_message: OptionalText,
  disabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  unavailable: Schema.optional(Schema.NullOr(Schema.Boolean)),
  runtime_only: Schema.optional(Schema.NullOr(Schema.Boolean)),
  next_retry_after: OptionalText,
});
export type CliProxyAuthFile = typeof AuthFile.Type;
const decodeAuthFiles = Schema.decodeUnknownEffect(
  Schema.Struct({ files: Schema.Array(AuthFile) }),
);
const decodeLogin = Schema.decodeUnknownEffect(
  Schema.Struct({ url: Schema.String, state: Schema.String }),
);
const decodeLoginStatus = Schema.decodeUnknownEffect(
  Schema.Struct({
    status: Schema.Literals(["ok", "wait", "error"]),
    error: OptionalText,
  }),
);
const decodeErrorBody = Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }));

const REQUEST_TIMEOUT = "15 seconds";
const MAX_PROXY_MESSAGE_LENGTH = 200;
// CLIProxyAPI names the Claude login after its upstream.
const LOGIN_PATHS: Record<ProviderProxyLoginProvider, string> = {
  claude: "anthropic-auth-url",
  codex: "codex-auth-url",
};

const nonEmpty = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};
const bounded = (value: string) =>
  value.length > MAX_PROXY_MESSAGE_LENGTH ? `${value.slice(0, MAX_PROXY_MESSAGE_LENGTH)}…` : value;

/** Maps one `auth-files` entry; config-defined API keys have no file to manage and are skipped. */
export function toProviderProxyAccount(
  file: CliProxyAuthFile,
  now: DateTime.Utc,
): ProviderProxyAccount | undefined {
  const name = nonEmpty(file.name);
  const provider = nonEmpty(file.provider) ?? nonEmpty(file.type);
  if (name === undefined || provider === undefined || file.runtime_only === true) return undefined;
  const email = nonEmpty(file.email) ?? nonEmpty(file.account) ?? nonEmpty(file.label);
  const retryAt = Option.flatMap(Option.fromNullishOr(nonEmpty(file.next_retry_after)), (value) =>
    Option.filter(DateTime.make(value), (at) => DateTime.isGreaterThan(at, now)),
  );
  const state: ProviderProxyAccount["state"] =
    file.disabled === true || file.status === "disabled"
      ? "disabled"
      : Option.isSome(retryAt)
        ? "cooldown"
        : file.status === "error" || file.unavailable === true
          ? "error"
          : "active";
  const statusMessage = state === "active" ? undefined : nonEmpty(file.status_message);
  return {
    name,
    provider,
    ...(email === undefined ? {} : { email }),
    state,
    ...(statusMessage === undefined ? {} : { statusMessage: bounded(statusMessage) }),
    ...(state === "cooldown" && Option.isSome(retryAt)
      ? { retryAt: DateTime.formatIso(retryAt.value) }
      : {}),
  };
}

/** The pasted URL must belong to the sign-in it completes. */
function redirectUrlMatchesLogin(redirectUrl: string, state: string): boolean {
  try {
    return new URL(redirectUrl).searchParams.get("state") === state;
  } catch {
    return false;
  }
}

export class ProxyAccounts extends Context.Service<
  ProxyAccounts,
  {
    readonly getState: Effect.Effect<ProviderProxyState>;
    readonly startLogin: (
      provider: ProviderProxyLoginProvider,
    ) => Effect.Effect<ProviderProxyLogin, ProviderProxyError>;
    readonly getLoginStatus: (
      state: string,
    ) => Effect.Effect<ProviderProxyLoginStatus, ProviderProxyError>;
    readonly completeLogin: (input: {
      readonly state: string;
      readonly redirectUrl: string;
    }) => Effect.Effect<void, ProviderProxyError>;
    readonly setAccountDisabled: (input: {
      readonly name: string;
      readonly disabled: boolean;
    }) => Effect.Effect<void, ProviderProxyError>;
    readonly removeAccount: (name: string) => Effect.Effect<void, ProviderProxyError>;
  }
>()("t3/providerProxy/ProxyAccounts") {}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const managed = yield* ManagedProviderProxy.ManagedProviderProxy;

  const context = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(() => new ProviderProxyError({ detail: "Could not read proxy settings." })),
    );
    const host = providerProxyHost(settings.providerProxy);
    const runtime: ProviderProxyRuntimeStatus =
      host === "managed" ? yield* managed.status : { status: "stopped" };
    const management = resolveProxyManagement(settings, yield* managed.endpoint);
    return { host, runtime, management };
  });

  const requireManagement = context.pipe(
    Effect.flatMap(({ management }) =>
      management === undefined
        ? Effect.fail(
            new ProviderProxyError({
              detail:
                "This environment cannot manage the proxy's accounts. Run the proxy here, or add the external proxy's management key.",
            }),
          )
        : Effect.succeed(management),
    ),
  );

  const request = Effect.fn("ProxyAccounts.request")(function* (
    management: ProxyManagementEndpoint,
    build: (url: string) => HttpClientRequest.HttpClientRequest,
    path: string,
  ) {
    // The deadline covers the body too: a proxy can send headers and then stall.
    const { response, body } = yield* client
      .execute(
        build(`${management.url}/v0/management/${path}`).pipe(
          HttpClientRequest.bearerToken(management.managementKey),
        ),
      )
      .pipe(
        Effect.flatMap((response) =>
          response.json.pipe(
            Effect.orElseSucceed((): unknown => null),
            Effect.map((body) => ({ response, body })),
          ),
        ),
        Effect.timeout(REQUEST_TIMEOUT),
        Effect.mapError(
          (error) =>
            new ProviderProxyError({
              detail: Cause.isTimeoutError(error)
                ? "The proxy did not answer within 15 seconds."
                : "Could not reach the proxy.",
            }),
        ),
      );
    if (response.status >= 200 && response.status < 300) return body;
    // CLIProxyAPI's own error strings, such as "auth file not found", carry no credentials.
    const proxyMessage = Option.match(decodeErrorBody(body), {
      onNone: () => "",
      onSome: ({ error }) => `: ${bounded(error)}`,
    });
    return yield* new ProviderProxyError({
      detail: `The proxy answered with HTTP ${response.status}${proxyMessage}.`,
    });
  });

  const malformed = () =>
    new ProviderProxyError({ detail: "The proxy sent a response T3 Code does not understand." });

  const getState: ProxyAccounts["Service"]["getState"] = Effect.gen(function* () {
    const { host, runtime, management } = yield* context;
    // A managed proxy that is not up yet has no accounts to read.
    if (management === undefined || (host === "managed" && runtime.status !== "running")) {
      return { runtime, accounts: null } satisfies ProviderProxyState;
    }
    return yield* request(management, HttpClientRequest.get, "auth-files").pipe(
      Effect.flatMap((body) => decodeAuthFiles(body).pipe(Effect.mapError(malformed))),
      Effect.flatMap(({ files }) =>
        DateTime.now.pipe(
          Effect.map((now) => files.flatMap((file) => toProviderProxyAccount(file, now) ?? [])),
        ),
      ),
      Effect.map((accounts): ProviderProxyState => ({ runtime, accounts })),
      Effect.catchTags({
        ProviderProxyError: (error) =>
          Effect.succeed({
            runtime,
            accounts: [],
            accountsError: error.detail,
          } satisfies ProviderProxyState),
      }),
    );
  }).pipe(
    Effect.catchTags({
      ProviderProxyError: () =>
        Effect.succeed({
          runtime: { status: "stopped" },
          accounts: null,
        } satisfies ProviderProxyState),
    }),
    Effect.withSpan("ProxyAccounts.getState"),
  );

  const startLogin = Effect.fn("ProxyAccounts.startLogin")(function* (
    provider: ProviderProxyLoginProvider,
  ) {
    const management = yield* requireManagement;
    const path = LOGIN_PATHS[provider];
    // Not `is_webui`: its callback forwarder binds 0.0.0.0, so sign-in completes by paste-back.
    const body = yield* request(management, HttpClientRequest.get, path);
    const login = yield* decodeLogin(body).pipe(Effect.mapError(malformed));
    // Clients open this URL; an external proxy must not hand them a file: or app link.
    if (URL.parse(login.url)?.protocol !== "https:") return yield* malformed();
    return login;
  });

  const getLoginStatus = Effect.fn("ProxyAccounts.getLoginStatus")(function* (state: string) {
    const management = yield* requireManagement;
    const body = yield* request(
      management,
      HttpClientRequest.get,
      `get-auth-status?state=${encodeURIComponent(state)}`,
    );
    const status = yield* decodeLoginStatus(body).pipe(Effect.mapError(malformed));
    const message = nonEmpty(status.error);
    return {
      status: status.status,
      ...(message === undefined ? {} : { message: bounded(message) }),
    } satisfies ProviderProxyLoginStatus;
  });

  const completeLogin = Effect.fn("ProxyAccounts.completeLogin")(function* (input: {
    readonly state: string;
    readonly redirectUrl: string;
  }) {
    if (!redirectUrlMatchesLogin(input.redirectUrl, input.state)) {
      return yield* new ProviderProxyError({
        detail:
          "Paste the full address from this sign-in's browser tab, including ?code=…&state=….",
      });
    }
    const management = yield* requireManagement;
    yield* request(
      management,
      (url) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ redirect_url: input.redirectUrl }),
        ),
      "oauth-callback",
    );
  });

  const setAccountDisabled = Effect.fn("ProxyAccounts.setAccountDisabled")(function* (input: {
    readonly name: string;
    readonly disabled: boolean;
  }) {
    const management = yield* requireManagement;
    yield* request(
      management,
      (url) =>
        HttpClientRequest.patch(url).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: input.name, disabled: input.disabled }),
        ),
      "auth-files/status",
    );
  });

  const removeAccount = Effect.fn("ProxyAccounts.removeAccount")(function* (name: string) {
    const management = yield* requireManagement;
    yield* request(
      management,
      HttpClientRequest.delete,
      `auth-files?name=${encodeURIComponent(name)}`,
    );
  });

  return ProxyAccounts.of({
    getState,
    startLogin,
    getLoginStatus,
    completeLogin,
    setAccountDisabled,
    removeAccount,
  });
});

export const layer = Layer.effect(ProxyAccounts, make);
