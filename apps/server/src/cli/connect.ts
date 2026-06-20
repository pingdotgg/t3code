import {
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
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
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { headlessRelayClientTracingLayer } from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
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

  const provisioned = status.linked
    ? "provisioned"
    : status.desired && status.authenticated
      ? "pending server startup"
      : "not provisioned";
  const nextStep = !status.authenticated
    ? "Run `t3 connect link` to authorize and enable T3 Connect."
    : !status.desired
      ? "Run `t3 connect link` to enable T3 Connect."
      : !status.linked
        ? "Start T3 to provision the environment link and launch its managed tunnel."
        : undefined;

  return [
    "T3 Connect",
    `  Exposure: ${status.desired ? "enabled" : "disabled"}`,
    `  Authorization: ${status.authenticated ? "stored credential" : "missing"}`,
    `  Environment link: ${provisioned}`,
    `  Relay: ${status.relayUrl ?? "not provisioned"}`,
    ...formatRelayClientStatus(status.relayClient),
    ...(nextStep ? ["", `Next: ${nextStep}`] : []),
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
      scopes: [AuthRelayWriteScope],
      subject: "cloud-cli",
      label: "t3 connect cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: unknown };

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

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

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
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  yield* CliState.setCliDesiredCloudLink(false);
  const liveResult = yield* runLiveCloudUnlink();
  const relayResult = yield* Effect.exit(unlinkRelayEnvironment());
  yield* CliState.clearPersistedCloudLink;

  if (options.clearAuthorization) {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    yield* tokens.clear;
  }

  if (liveResult.status === "failed") {
    yield* Console.warn(
      `T3 Connect is disabled, but the running server could not stop its tunnel: ${String(liveResult.cause)}\nRestart that server to stop the connector.`,
    );
  } else {
    yield* Console.log("T3 Connect is disabled locally.");
  }

  if (Exit.isFailure(relayResult)) {
    yield* Console.warn(
      options.clearAuthorization
        ? `Could not revoke the relay-side environment record before signing out: ${String(relayResult.cause)}\nThe stored CLI authorization was still removed locally.`
        : `Could not revoke the relay-side environment record yet: ${String(relayResult.cause)}\nRun \`t3 connect unlink\` again when the relay is reachable.`,
    );
  } else if (relayResult.value.status === "revoked") {
    yield* Console.log("Revoked the relay-side environment record.");
  }

  if (options.clearAuthorization) {
    yield* Console.log("Signed out of T3 Connect locally.");
  }
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
  },
) =>
  Effect.gen(function* () {
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
}).pipe(
  Command.withDescription("Authorize the T3 Connect CLI without enabling remote access."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        yield* tokens.get;
        yield* Console.log("Signed in to T3 Connect.");
      }),
    ),
  ),
);

const connectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription("Authorize this environment for T3 Connect on next start."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
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

        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        yield* tokens.get;
        yield* CliState.setCliDesiredCloudLink(true);
        yield* Console.log(
          "This T3 environment will be available through T3 Connect the next time T3 starts.",
        );
      }),
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
        const status: CloudCliStatus = {
          desired,
          authenticated,
          linked: Option.isSome(cloudUserId),
          cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
          relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
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

export const connectCommand = Command.make("connect").pipe(
  Command.withDescription("Manage headless T3 Connect access."),
  Command.withSubcommands([
    connectLoginCommand,
    connectLinkCommand,
    connectStatusCommand,
    connectUnlinkCommand,
    connectLogoutCommand,
  ]),
);
