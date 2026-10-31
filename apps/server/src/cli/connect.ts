import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentConnectReachability,
  EnvironmentHttpApi,
  formatConnectReachable,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { formatReachabilityFailure } from "../cloud/ConnectReachability.ts";
import { filterRelayResponse } from "../cloud/relayResponse.ts";
import {
  CLOUD_LINK_REVOKED,
  CLOUD_LINKED_USER_ID,
  isAgentActivityPublishingEnabledValue,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import * as RelayTracing from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import { resolveCliCommand } from "./invocation.ts";
import * as CliService from "./service.ts";

const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const isCloudCliTokenManagerError = Schema.is(CliTokenManager.CloudCliTokenManagerError);

export const headlessFlag = Flag.Boolean("headless").pipe(
  Flag.withDescription(
    "Sign in with a URL and code on any device. Automatic without a terminal or over SSH.",
  ),
  Flag.withDefault(false),
);

/**
 * Inside an SSH session there is no local browser to complete the loopback
 * OAuth callback, so the device authorization grant is the only flow that
 * can work.
 */
const headlessSessionConfig = Config.all({
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
}).pipe(
  Config.map(({ sshConnection, sshTty }) => Option.isSome(sshConnection) || Option.isSome(sshTty)),
);

const showDeviceAuthorizationPrompt = (prompt: CliTokenManager.DeviceAuthorizationPrompt) =>
  Console.log(formatDeviceAuthorizationPrompt(prompt));

function formatDeviceAuthorizationPrompt(
  prompt: CliTokenManager.DeviceAuthorizationPrompt,
): string {
  const minutes = Math.max(1, Math.round(Duration.toMinutes(prompt.expiresIn)));
  return [
    "Sign in to T3 Connect. Open on any device:",
    `  ${prompt.verificationUriComplete ?? prompt.verificationUri}`,
    `Code: ${prompt.userCode}`,
    `Waiting for approval. Expires in ${minutes} min. Ctrl+C cancels.`,
  ].join("\n");
}

const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly headless: boolean;
}) {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  // Without a terminal, no key press can open a browser, so sign in with a code.
  const useOutOfBandOAuth =
    options.headless ||
    (yield* headlessSessionConfig) ||
    !(process.stdin.isTTY && process.stdout.isTTY);
  if (!useOutOfBandOAuth) {
    const authorization = yield* tokens.get;
    if (authorization._tag === "Authorized") {
      return authorization.token.identity ?? null;
    }
  }
  const existing = yield* tokens.getExisting.pipe(
    Effect.catchTags({
      CloudCliCredentialRefreshError: () =>
        Console.log("T3 Connect sign-in expired. Sign in again.").pipe(Effect.as(Option.none())),
    }),
  );
  if (Option.isSome(existing)) {
    return existing.value.identity ?? null;
  }
  const { token, identity } = yield* CliTokenManager.deviceAuthorizationLogin(
    showDeviceAuthorizationPrompt,
  ).pipe(
    Effect.mapError((cause) =>
      isCloudCliTokenManagerError(cause)
        ? cause
        : new CliTokenManager.CloudCliAuthorizationError({ cause }),
    ),
  );
  yield* tokens.store(token);
  return identity;
});

function bytesToString(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly revoked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly publishAgentActivity: boolean;
  readonly relayClient: RelayClient.RelayClientStatus;
  readonly linkMode: CliState.CliDesiredLinkMode;
  /** `null` when no server answered the live check, or none ran because no tunnel is wanted. */
  readonly reachability: EnvironmentConnectReachability | null;
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

  const provisioned = status.revoked
    ? "removed from T3 Connect"
    : status.linked
      ? "provisioned"
      : status.desired && status.authenticated
        ? "pending server startup"
        : "not provisioned";
  const nextStep = !status.authenticated
    ? "Run `t3 connect link` to authorize and enable T3 Connect."
    : status.revoked
      ? "Run `t3 connect link` to link this environment again."
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
    `  Publish agent activity: ${status.publishAgentActivity ? "enabled" : "disabled"}`,
    ...formatRelayClientStatus(status.relayClient),
    ...(!status.desired || status.linkMode !== "managed"
      ? []
      : status.reachability === null
        ? [
            "",
            "No running server answered, so reachability was not checked. Check the background service with `t3 service status`.",
          ]
        : status.reachability.status === "reachable"
          ? [
              "",
              `✓ Other devices can reach this machine · ${formatConnectReachable(status.reachability)}`,
            ]
          : ["", formatReachabilityFailure(status.reachability)]),
    ...(nextStep ? ["", `Next: ${nextStep}`] : []),
  ].join("\n");
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const confirmRelayClientInstall = (version: string) =>
  Prompt.run(
    Prompt.Confirm({
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
  scope: AuthEnvironmentScope,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [scope],
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
    withCloudCliSessionToken(environmentAuth, AuthRelayWriteScope, (token) =>
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

// One check probes the endpoint, the tunnel edge, and Tailscale, each with its own timeout.
const CLOUD_CLI_REACHABILITY_TIMEOUT = Duration.seconds(30);
const CLOUD_CLI_REACHABILITY_WAIT = Duration.seconds(60);
const CLOUD_CLI_REACHABILITY_RETRY = Duration.seconds(5);

/** Asks the running server to check T3 Connect now. `null` when no server answers. */
const checkLiveReachability = Effect.fn("cloud.cli.check_live_reachability")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return null;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* withCloudCliSessionToken(environmentAuth, AuthRelayReadScope, (token) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: runtimeState.value.origin }).pipe(
      Effect.flatMap((client) =>
        client.connect.checkReachability({ headers: { authorization: `Bearer ${token}` } }),
      ),
      Effect.timeout(CLOUD_CLI_REACHABILITY_TIMEOUT),
    ),
  ).pipe(Effect.orElseSucceed(() => null));
});

function formatAlertBox(text: string): string {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const red = (line: string) => (color ? `\x1b[1;31m${line}\x1b[0m` : line);
  return [
    `┌${"─".repeat(width + 2)}┐`,
    ...lines.map((line) => `│ ${line.padEnd(width)} │`),
    `└${"─".repeat(width + 2)}┘`,
  ]
    .map(red)
    .join("\n");
}

/**
 * Waits for the server that `t3 connect` just started to prove other devices
 * can reach it, so a broken tunnel fails setup instead of looking green.
 */
export const waitForReachability = Effect.fn("cloud.cli.wait_for_reachability")(function* () {
  yield* Console.log("Checking T3 Connect...");
  const deadline =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(CLOUD_CLI_REACHABILITY_WAIT);
  let last: EnvironmentConnectReachability | null = null;
  while (true) {
    last = (yield* checkLiveReachability()) ?? last;
    if (last?.status === "reachable") {
      yield* Console.log("✓ T3 Connect is reachable.");
      return;
    }
    if ((yield* Clock.currentTimeMillis) >= deadline) break;
    yield* Effect.sleep(CLOUD_CLI_REACHABILITY_RETRY);
  }
  yield* Console.error(
    formatAlertBox(
      last === null
        ? "✕ Could not check T3 Connect\n  The T3 server on this machine did not answer.\n  Fix: run `t3 service status`, then `t3 connect status`."
        : formatReachabilityFailure(last),
    ),
  );
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

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

  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = yield* relayUrlConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(
    `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    httpClient.execute,
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

/**
 * Prints the local disconnect outcome, then whether the relay record was revoked.
 * A missing CLI login or a failed relay DELETE leaves that record registered, so
 * those outcomes warn to deregister it from the T3 Connect account page.
 */
const reportCloudDisconnectResults = Effect.fn("cloud.cli.report_disconnect_results")(
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
          : "Could not revoke the relay-side environment record yet.\nRun `t3 connect unlink` again when the relay is reachable, or deregister it from the T3 Connect page of your T3 account.",
      );
    } else if (input.relayResult.value.status === "not-authenticated") {
      yield* Console.warn(
        "The relay-side environment record was not revoked.\nDeregister it from the T3 Connect page of your T3 account, or run `t3 connect login` and retry.",
      );
    } else if (input.relayResult.value.status === "revoked") {
      yield* Console.log("Revoked the relay-side environment record.");
    }
  },
);

export const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
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

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult,
    relayResult,
  });

  if (options.clearAuthorization) {
    yield* Console.log(
      "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
    );
  }
  return liveResult;
});

export const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliTokenManager.CloudCliTokenManager
    | RelayClient.RelayClient
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const layerRuntime = Layer.mergeAll(
    ServerSecretStore.layer,
    CliTokenManager.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ExternalLauncher.layer),
    ),
    RelayClient.layerCloudflared({ baseDir: config.baseDir }),
    EnvironmentAuth.layerRuntime,
    CliService.layer(config),
    RelayTracing.layerHeadlessRelayClient,
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(layerRuntime));
});

const connectedAs = (identity: string | null): string => (identity ? ` as ${identity}` : "");

function formatRelayClientReady(version: string): string {
  return `✓ Relay client ready · cloudflared ${version}`;
}

const linkEnvironmentForConnect = Effect.fn("cloud.cli.link_environment")(function* (options: {
  readonly headless: boolean;
  readonly publishOnly?: boolean;
  /** For `t3 up`, where the user already chose T3 Connect: install it quietly, without asking. */
  readonly installRelayClient?: boolean;
}) {
  const publishOnly = options.publishOnly ?? false;
  if (!publishOnly) {
    const relayClient = yield* RelayClient.RelayClient;
    const installed = yield* acquireRelayClientForLink(
      relayClient,
      options.installRelayClient === true ? () => Effect.succeed(true) : confirmRelayClientInstall,
      options.installRelayClient === true
        ? (event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Console.log("Installing the T3 Connect relay client...")
              : Effect.void
        : reportRelayClientInstallProgress,
    );
    if (Option.isNone(installed)) {
      yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
      return null;
    }
    if (options.installRelayClient !== true) {
      yield* Console.log(formatRelayClientReady(installed.value.version));
    }
  }

  const identity = yield* authorizeCli(options);
  yield* CliState.setCliDesiredCloudLink(true, publishOnly ? "publish_only" : "managed");
  if (yield* CliState.dropRevokedCloudLink) {
    yield* Console.log("Replacing the link T3 Connect revoked.");
  }
  if (publishOnly) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
  }
  return { identity } as const;
});
export { linkEnvironmentForConnect };

const connectLoginCommand = Command.make("login", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Authorize the T3 Connect CLI without enabling remote access."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const identity = yield* authorizeCli(flags);
        yield* Console.log(`✓ Signed in${connectedAs(identity)}`);
      }),
    ),
  ),
);

const connectLinkCommand = Command.make("link", {
  ...projectLocationFlags,
  headless: headlessFlag,
  publishOnly: Flag.Boolean("publish-only").pipe(
    Flag.withDescription(
      "Link to publish agent activity only, with no managed tunnel. Reach this environment out of band (e.g. Tailscale).",
    ),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Authorize this environment for T3 Connect on next start."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const linked = yield* linkEnvironmentForConnect(flags);
        if (linked) {
          const serveCommand = yield* resolveCliCommand("serve");
          yield* Console.log(
            flags.publishOnly
              ? `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start T3 to publish agent activity (no managed tunnel).`
              : `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start the server with \`${serveCommand}\` to make this machine reachable.`,
          );
        }
      }),
    ),
  ),
);

const connectStatusCommand = Command.make("status", {
  ...projectLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show T3 Connect setup and check that other devices can reach this machine.",
  ),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const relayClient = yield* RelayClient.RelayClient;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const [
          desired,
          authenticated,
          cloudUserId,
          relayUrl,
          publishAgentActivity,
          revoked,
          executable,
          linkMode,
        ] = yield* Effect.all(
          [
            CliState.readCliDesiredCloudLink,
            tokens.hasCredential,
            secrets.get(CLOUD_LINKED_USER_ID),
            secrets.get(RELAY_URL_SECRET),
            secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
            secrets.get(CLOUD_LINK_REVOKED),
            relayClient.resolve,
            CliState.readCliDesiredLinkMode,
          ],
          { concurrency: "unbounded" },
        );
        // A publish-only link has no tunnel for other devices to reach.
        const reachability =
          desired && linkMode === "managed" ? yield* checkLiveReachability() : null;
        const status: CloudCliStatus = {
          desired,
          authenticated,
          linked: Option.isSome(cloudUserId),
          revoked: Option.isSome(cloudUserId) && Option.isSome(revoked),
          cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
          relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
          publishAgentActivity: isAgentActivityPublishingEnabledValue(
            Option.isSome(publishAgentActivity) ? bytesToString(publishAgentActivity.value) : null,
          ),
          relayClient: executable,
          linkMode,
          reachability,
        };
        yield* Console.log(formatCloudStatus(status, { json: flags.json }));
      }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const connectPublishCommand = Command.make("publish", {
  ...projectLocationFlags,
  disable: Flag.Boolean("disable").pipe(
    Flag.withDescription("Stop publishing agent activity to your mobile clients."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription(
    "Toggle publishing agent activity (push notifications and Live Activities) to your mobile clients.",
  ),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const enabled = !flags.disable;
        yield* secrets.set(
          PUBLISH_AGENT_ACTIVITY_SECRET,
          stringToBytes(enabled ? "true" : "false"),
        );
        if (!enabled) {
          // Cancel unprovisioned publish-only links too, or the next start will recreate them.
          // Managed links also serve the tunnel and must survive.
          const linkedNow = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
          if (!linkedNow && (yield* CliState.readCliDesiredLinkMode) === "publish_only") {
            yield* CliState.setCliDesiredCloudLink(false);
            yield* Console.log("Cancelled the pending publish-only T3 Connect link.");
          }
          yield* Console.log("Publishing agent activity disabled.");
          return;
        }

        yield* Console.log("Publishing agent activity enabled.");
        const linked = Option.isSome(yield* secrets.get(CLOUD_LINKED_USER_ID));
        if (linked) {
          return;
        }

        if (!(yield* tokens.hasCredential)) {
          yield* Console.log(
            "Run `t3 connect login` first so this environment can be authorized to publish.",
          );
          return;
        }
        // A desired managed link already covers publishing and must not be downgraded.
        if (yield* CliState.readCliDesiredCloudLink) {
          yield* Console.log(
            "A T3 Connect link is already pending. Start T3 to finish provisioning it; publishing starts once it links.",
          );
          return;
        }
        yield* CliState.setCliDesiredCloudLink(true, "publish_only");
        yield* Console.log(
          "Restart T3 to finish authorizing this environment to publish (no managed tunnel is created).",
        );
      }),
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

// `t3 connect` itself is `t3 up --connect`, in up.ts.
export const connectSubcommands = [
  connectLoginCommand,
  connectLinkCommand,
  connectPublishCommand,
  connectStatusCommand,
  connectUnlinkCommand,
  connectLogoutCommand,
] as const;
