// @ts-nocheck
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type EnvironmentCloudLinkStateResult,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { CLOUD_LINKED_USER_ID, RELAY_URL_SECRET } from "../cloud/config.ts";
import {
  hasCloudCliOAuthConfig,
  hasCloudPublicConfig,
  relayUrlConfig,
} from "../cloud/publicConfig.ts";
import { headlessRelayClientTracingLayer } from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const headlessFlag = Flag.boolean("headless").pipe(
  Flag.withDescription("Authorize without a local browser using an authorization code."),
  Flag.withDefault(false),
);

export function isHeadlessConnectEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(env.SSH_CONNECTION?.trim() || env.SSH_TTY?.trim());
}

export function formatHeadlessAuthorizationPrompt(authorizeUrl: string): string {
  return [
    "Headless authorization",
    "Open this URL on a device with a browser:",
    `  ${authorizeUrl}`,
    "",
    "After signing in, return here and enter the code shown in your browser.",
  ].join("\n");
}

type CloudConfigurationRequirement = "oauth" | "full";

interface CloudConfigurationAvailability {
  readonly hasCliOAuthConfig: boolean;
  readonly hasPublicConfig: boolean;
}

export function cloudConfigurationError(
  requirement: CloudConfigurationRequirement | undefined,
  availability: CloudConfigurationAvailability = {
    hasCliOAuthConfig: hasCloudCliOAuthConfig,
    hasPublicConfig: hasCloudPublicConfig,
  },
): string | undefined {
  if (requirement === "oauth" && !availability.hasCliOAuthConfig) {
    return "T3 Connect login is not configured. Set T3CODE_CLERK_PUBLISHABLE_KEY and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID.";
  }
  if (requirement === "full" && !availability.hasPublicConfig) {
    return "T3 Connect is not configured. Set T3CODE_RELAY_URL, T3CODE_CLERK_PUBLISHABLE_KEY, and T3CODE_CLERK_CLI_OAUTH_CLIENT_ID.";
  }
  return undefined;
}

const requireCloudCliOAuthConfig = (() => {
  const message = cloudConfigurationError("oauth");
  return message ? Effect.fail(new Error(message)) : Effect.void;
})();

const requireCloudPublicConfig = (() => {
  const message = cloudConfigurationError("full");
  return message ? Effect.fail(new Error(message)) : Effect.void;
})();

const promptForOutOfBandOAuthCode = Effect.fn("cloud.cli.prompt_out_of_band_code")(function* (
  input: CliTokenManager.OutOfBandOAuthPromptInput,
) {
  yield* Console.log(formatHeadlessAuthorizationPrompt(input.authorizeUrl));
  return yield* Prompt.run(
    Prompt.text({ message: "Authorization code", validate: input.validate }),
  );
});

export const authorizeCliWith = Effect.fn("cloud.cli.authorize_with")(function* (
  options: { readonly headless: boolean; readonly sshSession?: boolean },
  tokens: CliTokenManager.CloudCliTokenManager["Service"],
  loginOutOfBand: Effect.Effect<{
    readonly token: CliTokenManager.PersistedToken;
    readonly identity: string | null;
  }>,
) {
  if (!options.headless && !options.sshSession) {
    const token = yield* tokens.get;
    return token.identity ?? null;
  }
  const existing = yield* tokens.getExisting.pipe(
    Effect.catchTag("CloudCliCredentialRefreshError", () =>
      Console.log(
        "The stored T3 Connect credential could not be refreshed; signing in again.",
      ).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isSome(existing)) return existing.value.identity ?? null;
  const authorization = yield* loginOutOfBand;
  yield* tokens.store(authorization.token);
  return authorization.identity;
});

const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly headless: boolean;
}) {
  yield* requireCloudCliOAuthConfig;
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  return yield* authorizeCliWith(
    { ...options, sshSession: isHeadlessConnectEnvironment() },
    tokens,
    CliTokenManager.outOfBandOAuthLogin(promptForOutOfBandOAuthCode),
  );
});
function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

interface CloudCliStatus {
  readonly state:
    | "logged-out"
    | "authenticated-disabled"
    | "link-pending"
    | "linked-offline"
    | "linked-online";
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly endpointRuntime:
    | { readonly status: "not-running" }
    | { readonly status: "unavailable" }
    | EnvironmentCloudLinkStateResult["endpointRuntimeStatus"];
  readonly relayClient: RelayClient.RelayClientStatus;
}

function formatRelayClientStatus(executable: RelayClient.RelayClientStatus): ReadonlyArray<string> {
  switch (executable.status) {
    case "available": {
      const source =
        executable.source === "path"
          ? "PATH"
          : executable.source === "managed"
            ? "managed install"
            : "configured override";
      return [
        `  Relay client: available via ${source}`,
        `    Path: ${executable.executablePath}`,
        `    Version: ${executable.version}`,
      ];
    }
    case "missing":
      return ["  Relay client: not installed"];
    case "unsupported":
      return [
        `  Relay client: unsupported on ${executable.platform}-${executable.arch}`,
        `    Managed version: ${executable.version}`,
      ];
  }
}

function formatCloudStatus(status: CloudCliStatus, options?: { readonly json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify(status, null, 2);
  }

  const detail = {
    "logged-out": {
      label: "logged out",
      next: "Run `t3 connect link` to authorize and enable T3 Connect.",
    },
    "authenticated-disabled": {
      label: "authenticated, disabled",
      next: "Run `t3 connect link` to enable T3 Connect.",
    },
    "link-pending": {
      label: "link desired, not provisioned",
      next: "Start T3 to provision the environment link and launch its managed tunnel.",
    },
    "linked-offline": {
      label: "linked, tunnel offline or unavailable",
      next: "Start or restart T3, then run `t3 connect status` again.",
    },
    "linked-online": {
      label: "linked and online",
      next: undefined,
    },
  }[status.state];

  return [
    "T3 Connect",
    `  Status: ${detail.label}`,
    `  Exposure: ${status.desired ? "enabled" : "disabled"}`,
    `  Authorization: ${status.authenticated ? "stored credential" : "missing"}`,
    `  Environment link: ${status.linked ? "provisioned" : "not provisioned"}`,
    `  Relay: ${status.relayUrl ?? "not provisioned"}`,
    ...formatRelayClientStatus(status.relayClient),
    ...(detail.next ? ["", `Next: ${detail.next}`] : []),
  ].join("\n");
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const confirmRelayClientInstall = (version: string) =>
  Prompt.run(
    Prompt.confirm({
      message: `The T3 relay client is required for T3 Connect. Download and install version ${version}?`,
      initial: false,
    }),
  );

function relayClientInstallProgressMessage(stage: RelayClientInstallProgressStage): string {
  switch (stage) {
    case "checking":
      return "Checking existing installation";
    case "waiting_for_lock":
      return "Waiting for installation lock";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying download";
    case "installing":
      return "Installing";
    case "validating":
      return "Validating executable";
    case "activating":
      return "Activating installation";
  }
}

const reportRelayClientInstallProgress = (event: RelayClientInstallProgressEvent) =>
  event.type === "progress"
    ? Console.log(`Relay client: ${relayClientInstallProgressMessage(event.stage)}...`)
    : Effect.void;

export const acquireRelayClientForLink = Effect.fn("cloud.cli.acquire_relay_client_for_link")(
  function* <ConfirmError, ConfirmContext>(
    relayClient: RelayClient.RelayClient["Service"],
    confirmInstall: (version: string) => Effect.Effect<boolean, ConfirmError, ConfirmContext>,
    reportProgress: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) {
    const executable = yield* relayClient.resolve;
    if (executable.status === "available") {
      return Option.some(executable);
    }
    if (executable.status === "unsupported") {
      return Option.some(yield* relayClient.installWithProgress(reportProgress));
    }
    if (!(yield* confirmInstall(executable.version))) {
      return Option.none();
    }
    return Option.some(yield* relayClient.installWithProgress(reportProgress));
  },
);

const withCloudCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [AuthRelayReadScope, AuthRelayWriteScope],
      subject: "cloud-cli",
      label: "t3 connect cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: Cause.Cause<unknown> };

const runLiveCloudUnlink = Effect.fn("cloud.cli.run_live_unlink")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudActionResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, (token) =>
      HttpApiClient.make(EnvironmentHttpApi, {
        baseUrl: runtimeState.value.origin,
      }).pipe(
        Effect.flatMap((client) =>
          client.connect.unlink({ headers: { authorization: `Bearer ${token}` } }),
        ),
        Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
      ),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "succeeded" } satisfies LiveCloudActionResult)
    : ({ status: "failed", cause: result.cause } satisfies LiveCloudActionResult);
});

type LiveCloudLinkStateResult =
  | { readonly status: "not-running" }
  | { readonly status: "available"; readonly value: EnvironmentCloudLinkStateResult }
  | { readonly status: "unavailable"; readonly cause: Cause.Cause<unknown> };

const runLiveCloudLinkState = Effect.fn("cloud.cli.run_live_link_state")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudLinkStateResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, (token) =>
      HttpApiClient.make(EnvironmentHttpApi, {
        baseUrl: runtimeState.value.origin,
      }).pipe(
        Effect.flatMap((client) =>
          client.connect.linkState({ headers: { authorization: `Bearer ${token}` } }),
        ),
        Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
      ),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "available", value: result.value } satisfies LiveCloudLinkStateResult)
    : ({ status: "unavailable", cause: result.cause } satisfies LiveCloudLinkStateResult);
});

export function cloudConnectionStatus(input: {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly endpointRuntime: CloudCliStatus["endpointRuntime"];
}): CloudCliStatus["state"] {
  if (!input.authenticated) return "logged-out";
  if (!input.desired) return "authenticated-disabled";
  if (!input.linked) return "link-pending";
  return typeof input.endpointRuntime === "object" &&
    input.endpointRuntime !== null &&
    "status" in input.endpointRuntime &&
    input.endpointRuntime.status === "running"
    ? "linked-online"
    : "linked-offline";
}

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

export function relayUnlinkResultFromStatus(status: number): RelayUnlinkResult | undefined {
  return status === 404 ? { status: "not-linked" } : undefined;
}

type CloudDisconnectOperation = "live-server-unlink" | "relay-environment-unlink";

const logCloudDisconnectFailure = (
  operation: CloudDisconnectOperation,
  clearAuthorization: boolean,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logWarning("T3 Connect disconnect operation failed.").pipe(
    Effect.annotateLogs({
      operation,
      clearAuthorization,
      cause: Cause.pretty(cause),
    }),
  );

const unlinkRelayEnvironment = Effect.fn("cloud.cli.unlink_relay_environment")(function* () {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const token = yield* tokens.getExisting;
  if (Option.isNone(token)) {
    return { status: "not-authenticated" } satisfies RelayUnlinkResult;
  }

  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = yield* relayUrlConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(
    `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    httpClient.execute,
    Effect.flatMap((response) => {
      const unlinked = relayUnlinkResultFromStatus(response.status);
      return unlinked === undefined
        ? HttpClientResponse.filterStatusOk(response).pipe(
            Effect.map((okResponse) => ({ _tag: "response" as const, okResponse })),
          )
        : Effect.succeed({ _tag: "result" as const, result: unlinked });
    }),
    Effect.flatMap((result) =>
      result._tag === "result"
        ? Effect.succeed(result.result)
        : HttpClientResponse.schemaBodyJson(RelayOkResponse)(result.okResponse),
    ),
    withRelayClientTracing,
  );
  if ("status" in response) return response;
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

export const reportCloudDisconnectResults = Effect.fn("cloud.cli.report_disconnect_results")(
  function* (input: {
    readonly clearAuthorization: boolean;
    readonly liveResult: LiveCloudActionResult;
    readonly relayResult: Exit.Exit<RelayUnlinkResult, unknown>;
  }) {
    if (input.liveResult.status === "failed") {
      yield* logCloudDisconnectFailure(
        "live-server-unlink",
        input.clearAuthorization,
        input.liveResult.cause,
      );
      yield* Console.warn(
        "T3 Connect is disabled, but the running server could not stop its tunnel.\nRestart that server to stop the connector.",
      );
    } else {
      yield* Console.log("T3 Connect is disabled locally.");
    }

    if (Exit.isFailure(input.relayResult)) {
      yield* logCloudDisconnectFailure(
        "relay-environment-unlink",
        input.clearAuthorization,
        input.relayResult.cause,
      );
      yield* Console.warn(
        input.clearAuthorization
          ? "Could not revoke the relay-side environment record before signing out.\nThe stored CLI authorization was still removed locally."
          : "Could not revoke the relay-side environment record yet.\nRun `t3 connect unlink` again when the relay is reachable.",
      );
    } else if (input.relayResult.value.status === "revoked") {
      yield* Console.log("Revoked the relay-side environment record.");
    } else if (input.relayResult.value.status === "not-authenticated") {
      yield* Console.warn(
        input.clearAuthorization
          ? "No stored CLI authorization was available to revoke the relay-side environment record.\nT3 Connect is signed out locally; sign in and run `t3 connect unlink` if the remote record still exists."
          : "No stored CLI authorization was available to revoke the relay-side environment record.\nSign in and run `t3 connect unlink` if the remote record still exists.",
      );
    }
  },
);

const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  const tokens = options.clearAuthorization
    ? yield* CliTokenManager.CloudCliTokenManager
    : undefined;
  const result = yield* executeCloudDisconnect({
    disableLocal: CliState.setCliDesiredCloudLink(false),
    stopLiveTunnel: runLiveCloudUnlink(),
    revokeRelayEnvironment: unlinkRelayEnvironment(),
    clearMetadata: CliState.clearPersistedCloudLink,
    ...(tokens ? { clearAuthorization: tokens.clear } : {}),
  });

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult: result.liveResult,
    relayResult: result.relayResult,
  });

  if (Exit.isFailure(result.metadataResult)) {
    yield* Effect.logWarning("T3 Connect metadata cleanup was incomplete.", {
      cause: Cause.pretty(result.metadataResult.cause),
      clearAuthorization: options.clearAuthorization,
    });
    yield* Console.warn(
      "T3 Connect remains disabled, but some local relay metadata could not be removed.\nRun `t3 connect unlink` again after fixing local secret-store access.",
    );
  }

  if (result.authorizationResult && Exit.isFailure(result.authorizationResult)) {
    yield* Effect.logWarning("T3 Connect CLI authorization cleanup failed.", {
      cause: Cause.pretty(result.authorizationResult.cause),
    });
    yield* Console.warn(
      "T3 Connect remains disabled, but the stored CLI authorization could not be removed.\nRun `t3 connect logout` again after fixing local secret-store access.",
    );
  }

  if (
    options.clearAuthorization &&
    result.authorizationResult &&
    Exit.isSuccess(result.authorizationResult)
  ) {
    yield* Console.log("Signed out of T3 Connect locally.");
  }

  yield* completeCloudDisconnect({
    liveResult: result.liveResult,
    metadataResult: result.metadataResult,
    ...(result.authorizationResult ? { authorizationResult: result.authorizationResult } : {}),
  });
});

export const completeCloudDisconnect = Effect.fn("cloud.cli.complete_disconnect")(
  function* (result: {
    readonly liveResult: LiveCloudActionResult;
    readonly metadataResult: Exit.Exit<void, unknown>;
    readonly authorizationResult?: Exit.Exit<void, unknown> | undefined;
  }) {
    if (result.liveResult.status === "failed") {
      return yield* Effect.fail(
        new Error(
          "T3 Connect is disabled locally, but the running server could not stop its tunnel. Restart that server to stop the connector.",
        ),
      );
    }
    if (Exit.isFailure(result.metadataResult)) {
      return yield* Effect.fail(
        new Error(
          "T3 Connect local metadata cleanup was incomplete; the connection remains disabled.",
        ),
      );
    }
    if (result.authorizationResult && Exit.isFailure(result.authorizationResult)) {
      return yield* Effect.fail(
        new Error(
          "T3 Connect authorization cleanup was incomplete; the connection remains disabled.",
        ),
      );
    }
  },
);

export const executeCloudDisconnect = Effect.fn("cloud.cli.execute_disconnect")(function* (input: {
  readonly disableLocal: Effect.Effect<void, unknown>;
  readonly stopLiveTunnel: Effect.Effect<LiveCloudActionResult, unknown>;
  readonly revokeRelayEnvironment: Effect.Effect<RelayUnlinkResult, unknown>;
  readonly clearMetadata: Effect.Effect<void, unknown>;
  readonly clearAuthorization?: Effect.Effect<void, unknown>;
}) {
  // This precedes every network operation. A relay outage must not turn a
  // deliberate local disconnect into a link on the next server restart.
  yield* input.disableLocal;
  return {
    liveResult: yield* input.stopLiveTunnel.pipe(
      Effect.catchCause((cause) => Effect.succeed({ status: "failed" as const, cause })),
    ),
    relayResult: yield* Effect.exit(input.revokeRelayEnvironment),
    metadataResult: yield* Effect.exit(input.clearMetadata),
    authorizationResult: input.clearAuthorization
      ? yield* Effect.exit(input.clearAuthorization)
      : undefined,
  };
});

const runCloudCommand = <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliTokenManager.CloudCliTokenManager
    | RelayClient.RelayClient
    | EnvironmentAuth.EnvironmentAuth
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironment
  >,
  options?: {
    readonly quietLogs?: boolean;
    readonly configuration?: CloudConfigurationRequirement;
  },
) =>
  Effect.gen(function* () {
    const configurationError = cloudConfigurationError(options?.configuration);
    if (configurationError) {
      return yield* Effect.fail(new Error(configurationError));
    }
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    const runtimeLayer = Layer.mergeAll(
      ServerSecretStore.layer,
      CliTokenManager.layer.pipe(Layer.provide(ServerSecretStore.layer)),
      RelayClient.layerCloudflared({ baseDir: config.baseDir }),
      EnvironmentAuth.runtimeLayer,
      ServerEnvironment.layer,
      headlessRelayClientTracingLayer,
    ).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );
    return yield* run.pipe(Effect.provide(runtimeLayer));
  });

const connectLoginCommand = Command.make("login", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Authorize the T3 Connect CLI without enabling remote access."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const identity = yield* authorizeCli(flags);
        yield* Console.log(`Signed in to T3 Connect${identity ? ` as ${identity}` : ""}.`);
      }),
      { configuration: "oauth" },
    ),
  ),
);

const connectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Authorize this environment for T3 Connect on next start."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* requireCloudPublicConfig;
        const relayClient = yield* RelayClient.RelayClient;
        const installed = yield* acquireRelayClientForLink(
          relayClient,
          confirmRelayClientInstall,
          reportRelayClientInstallProgress,
        );
        if (Option.isNone(installed)) {
          yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
          return;
        }
        yield* Console.log(
          `Using relay client ${installed.value.version} from ${installed.value.executablePath}.`,
        );

        const identity = yield* authorizeCli(flags);
        yield* CliState.setCliDesiredCloudLink(true);
        yield* Console.log(
          `This T3 environment${identity ? ` (${identity})` : ""} will be available through T3 Connect the next time T3 starts.`,
        );
      }),
      { configuration: "full" },
    ),
  ),
);

const connectStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show persisted T3 Connect and relay client state."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const relayClient = yield* RelayClient.RelayClient;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const [desired, authenticated, cloudUserId, relayUrl, executable] = yield* Effect.all(
          [
            CliState.readCliDesiredCloudLink,
            tokens.hasCredential,
            secrets.get(CLOUD_LINKED_USER_ID),
            secrets.get(RELAY_URL_SECRET),
            relayClient.resolve,
          ],
          { concurrency: "unbounded" },
        );
        const live = yield* runLiveCloudLinkState();
        const liveState = live.status === "available" ? live.value : undefined;
        const linked = liveState?.linked ?? Option.isSome(cloudUserId);
        const endpointRuntime =
          liveState?.endpointRuntimeStatus ??
          (live.status === "not-running"
            ? ({ status: "not-running" } as const)
            : ({ status: "unavailable" } as const));
        const status: CloudCliStatus = {
          state: cloudConnectionStatus({
            desired,
            authenticated,
            linked,
            endpointRuntime,
          }),
          desired,
          authenticated,
          linked,
          cloudUserId:
            liveState === undefined
              ? Option.isSome(cloudUserId)
                ? bytesToString(cloudUserId.value)
                : null
              : liveState.cloudUserId,
          relayUrl:
            liveState === undefined
              ? Option.isSome(relayUrl)
                ? bytesToString(relayUrl.value)
                : null
              : liveState.relayUrl,
          endpointRuntime,
          relayClient: executable,
        };
        yield* Console.log(formatCloudStatus(status, { json: flags.json }));
      }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const connectUnlinkCommand = Command.make("unlink", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Connect while retaining the stored authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: false })),
  ),
);

const connectLogoutCommand = Command.make("logout", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Disable T3 Connect and clear the stored CLI authorization."),
  Command.withHandler((flags) =>
    runCloudCommand(flags, disconnectCloud({ clearAuthorization: true })),
  ),
);

const connectSetupCommand = Command.make("connect", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Set up T3 Connect for this machine."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* requireCloudPublicConfig;
        const relayClient = yield* RelayClient.RelayClient;
        const installed = yield* acquireRelayClientForLink(
          relayClient,
          confirmRelayClientInstall,
          reportRelayClientInstallProgress,
        );
        if (Option.isNone(installed)) {
          yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
          return;
        }
        const identity = yield* authorizeCli(flags);
        yield* CliState.setCliDesiredCloudLink(true);
        yield* Console.log(
          `Connected${identity ? ` as ${identity}` : ""}. Start T3 to provision this environment.`,
        );
      }),
      { configuration: "full" },
    ),
  ),
);

export const connectCommand = connectSetupCommand.pipe(
  Command.withSubcommands([
    connectLoginCommand,
    connectLinkCommand,
    connectStatusCommand,
    connectUnlinkCommand,
    connectLogoutCommand,
  ]),
);
