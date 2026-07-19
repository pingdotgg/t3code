import {
  AuthRelayWriteScope,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import * as Terminal from "effect/Terminal";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Command, Flag, GlobalFlag, Prompt } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import packageJson from "../../package.json" with { type: "json" };
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import {
  CLOUD_LINKED_USER_ID,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { headlessRelayClientTracingLayer } from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as ProcessRunner from "../processRunner.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const isCloudCliTokenManagerError = Schema.is(CliTokenManager.CloudCliTokenManagerError);

const headlessFlag = Flag.boolean("headless").pipe(
  Flag.withDescription("Authorize without a local browser using out-of-band OAuth."),
  Flag.withDefault(false),
);

/**
 * Inside an SSH session there is no local browser to complete the loopback
 * OAuth callback, so out-of-band OAuth is the only flow that can work.
 */
export const headlessSessionConfig = Config.all({
  sshConnection: Config.string("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.string("SSH_TTY").pipe(Config.option),
}).pipe(
  Config.map(({ sshConnection, sshTty }) => Option.isSome(sshConnection) || Option.isSome(sshTty)),
);

const promptForOutOfBandOAuthCode = Effect.fn("cloud.cli.prompt_for_out_of_band_oauth_code")(
  function* ({ authorizeUrl, validate }: CliTokenManager.OutOfBandOAuthPromptInput) {
    yield* Console.log(formatHeadlessAuthorizationPrompt(authorizeUrl));
    return yield* Prompt.run(Prompt.text({ message: "Authorization code", validate }));
  },
);

export function formatHeadlessAuthorizationPrompt(authorizeUrl: string): string {
  return [
    "Headless authorization",
    "Open this URL on a device with a browser:",
    `  ${authorizeUrl}`,
    "",
    "After signing in, return here and enter the code shown in your browser.",
  ].join("\n");
}

/** Returns the connected account identity, if the flow could determine one. */
const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly headless: boolean;
}) {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const useOutOfBandOAuth = options.headless || (yield* headlessSessionConfig);
  if (!useOutOfBandOAuth) {
    const authorization = yield* tokens.get;
    if (authorization._tag === "Authorized") {
      return authorization.token.identity ?? null;
    }
    yield* Console.log("\nHeadless mode enabled. A new authorization link is ready below.");
  }
  // A stored credential whose refresh fails (revoked, expired grant) must
  // fall through to a fresh out-of-band authorization, not dead-end the command.
  const existing = yield* tokens.getExisting.pipe(
    Effect.catchTag("CloudCliCredentialRefreshError", () =>
      Console.log(
        "The stored T3 Connect credential could not be refreshed; signing in again.",
      ).pipe(Effect.as(Option.none())),
    ),
  );
  if (Option.isSome(existing)) {
    return existing.value.identity ?? null;
  }
  const { token, identity } = yield* CliTokenManager.outOfBandOAuthLogin(
    promptForOutOfBandOAuthCode,
  ).pipe(
    Effect.mapError((cause) =>
      // Ctrl-C / EOF at the prompt is a QuitError; let it propagate so the CLI
      // cancels quietly instead of dumping an authorization error.
      Terminal.isQuitError(cause) || isCloudCliTokenManagerError(cause)
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

export function isPublishAgentActivityEnabledValue(value: string | null): boolean {
  return value === "true";
}

interface CloudCliStatus {
  readonly desired: boolean;
  readonly authenticated: boolean;
  readonly linked: boolean;
  readonly cloudUserId: string | null;
  readonly relayUrl: string | null;
  readonly publishAgentActivity: boolean;
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
    `  Publish agent activity: ${status.publishAgentActivity ? "enabled" : "disabled"}`,
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
    }
  },
);

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

    // uninstall itself no-ops when nothing is installed (and on non-Linux),
    // so no status pre-check that could mask a real removal failure.
    const bootService = yield* BootService.BootService;
    yield* bootService.uninstall.pipe(
      Effect.tap((removed) =>
        removed ? Console.log("Removed the T3 Code background service.") : Effect.void,
      ),
      Effect.catchTag("BootServiceUnsupportedError", () => Effect.succeed(false)),
      Effect.catch((error) =>
        Console.warn(`Could not remove the background service: ${error.message}`).pipe(
          Effect.as(false),
        ),
      ),
    );
  }

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult,
    relayResult,
  });

  if (options.clearAuthorization) {
    yield* Console.log("Signed out of T3 Connect locally.");
  }
});

const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
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
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironment
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const runtimeLayer = Layer.mergeAll(
    ServerSecretStore.layer,
    CliTokenManager.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ExternalLauncher.layer),
    ),
    RelayClient.layerCloudflared({ baseDir: config.baseDir }),
    EnvironmentAuth.runtimeLayer,
    ServerEnvironment.layer,
    BootService.layer({
      baseDir: config.baseDir,
      logsDir: config.logsDir,
      cliVersion: packageJson.version,
    }).pipe(Layer.provide(ProcessRunner.layer)),
    headlessRelayClientTracingLayer,
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(runtimeLayer));
});

const connectedAs = (identity: string | null): string => (identity ? ` as ${identity}` : "");

export function formatRelayClientReady(version: string): string {
  return `✓ Relay client ready · cloudflared ${version}`;
}

const linkEnvironmentForConnect = Effect.fn("cloud.cli.link_environment")(function* (options: {
  readonly headless: boolean;
  readonly publishOnly?: boolean;
}) {
  const publishOnly = options.publishOnly ?? false;
  if (!publishOnly) {
    const relayClient = yield* RelayClient.RelayClient;
    const installed = yield* acquireRelayClientForLink(
      relayClient,
      confirmRelayClientInstall,
      reportRelayClientInstallProgress,
    );
    if (Option.isNone(installed)) {
      yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
      return null;
    }
    yield* Console.log(formatRelayClientReady(installed.value.version));
  }

  const identity = yield* authorizeCli(options);
  yield* CliState.setCliDesiredCloudLink(true, publishOnly ? "publish_only" : "managed");
  if (publishOnly) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
  }
  return { identity } as const;
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
  publishOnly: Flag.boolean("publish-only").pipe(
    Flag.withDescription(
      "Link to publish agent activity only — no managed tunnel. Reach this environment out of band (e.g. Tailscale).",
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
          yield* Console.log(
            flags.publishOnly
              ? `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start T3 to publish agent activity (no managed tunnel).`
              : `✓ Authorized${connectedAs(linked.identity)}\n\nNext\n  Start the server with \`t3 serve\` to make this machine reachable.`,
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
  Command.withDescription("Show persisted T3 Connect and relay client state."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const relayClient = yield* RelayClient.RelayClient;
        const tokens = yield* CliTokenManager.CloudCliTokenManager;
        const [desired, authenticated, cloudUserId, relayUrl, publishAgentActivity, executable] =
          yield* Effect.all(
            [
              CliState.readCliDesiredCloudLink,
              tokens.hasCredential,
              secrets.get(CLOUD_LINKED_USER_ID),
              secrets.get(RELAY_URL_SECRET),
              secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
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
          publishAgentActivity: isPublishAgentActivityEnabledValue(
            Option.isSome(publishAgentActivity) ? bytesToString(publishAgentActivity.value) : null,
          ),
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

const connectPublishCommand = Command.make("publish", {
  ...projectLocationFlags,
  disable: Flag.boolean("disable").pipe(
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
          // If enabling scheduled a publish-only link that hasn't been
          // provisioned yet, disabling must cancel it too — otherwise the next
          // start still links an environment whose only purpose was publishing.
          // A pending managed link is left alone; it exists for the tunnel.
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

        // Publishing needs the relay to know this environment belongs to you.
        // Establish a tunnel-free publish-only link automatically so signing in
        // is all it takes — the mobile client can still reach the environment
        // out of band without T3 Connect.
        if (!(yield* tokens.hasCredential)) {
          yield* Console.log(
            "Run `t3 connect login` first so this environment can be authorized to publish.",
          );
          return;
        }
        // A link may already be desired (e.g. `t3 connect link` before the
        // server's first start). Never downgrade it: a desired managed link
        // also covers publishing, so only request a publish-only link when no
        // link is pending at all.
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

const offerBootService = Effect.gen(function* () {
  const bootService = yield* BootService.BootService;
  const { supported, installed, current } = yield* bootService.status;
  if (!supported) {
    // Don't prompt for something that can only fail; background setup is
    // Linux/systemd-only for now.
    return false;
  }
  if (installed && current) {
    yield* Console.log("T3 Code is already set up to run in the background on this machine.");
    return true;
  }
  const wanted = yield* Prompt.run(
    Prompt.confirm({
      message: installed
        ? "The installed T3 Code background service is from an older setup. Update it now?"
        : "Run T3 Code in the background whenever this machine boots? " +
          "It stays reachable through T3 Connect even after you log out.",
      initial: true,
    }),
  );
  if (!wanted) {
    return false;
  }
  const plan = yield* bootService.install;
  yield* Console.log(`Background service installed. Logs: ${plan.logPath}`);
  return true;
});

export const recoverBootServiceOffer = <R>(
  offer: Effect.Effect<boolean, BootService.BootServiceError | Terminal.QuitError, R>,
) =>
  offer.pipe(
    Effect.catchTags({
      QuitError: () => Effect.succeed(false),
      BootServiceUnsupportedError: (error) =>
        Console.log(`Skipping background setup: ${error.message}`).pipe(Effect.as(false)),
      BootServiceCommandError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
      BootServiceInstallError: (error) =>
        Console.warn(`Background setup did not finish: ${error.message}`).pipe(Effect.as(false)),
    }),
  );

export const connectCommand = Command.make("connect", {
  ...projectLocationFlags,
  headless: headlessFlag,
}).pipe(
  Command.withDescription("Set up T3 Connect for this machine."),
  Command.withHandler((flags) =>
    runCloudCommand(
      flags,
      Effect.gen(function* () {
        yield* Console.log("T3 Connect\n");
        const linked = yield* linkEnvironmentForConnect(flags);
        if (!linked) {
          return;
        }
        // Show which account was linked so an unexpected identity (an
        // authorization code for a different account) is visible before the
        // machine is brought online.
        yield* Console.log(`✓ Connected${connectedAs(linked.identity)}`);

        // Connect itself already succeeded; a boot-service failure must not
        // fail the command, just tell the user what happened and move on.
        const background = yield* recoverBootServiceOffer(offerBootService);
        yield* Console.log(
          background
            ? "\n✓ Background service ready\n\nT3 Code will stay reachable after you log out."
            : "\nNext\n  Start the server with `t3 serve` to make this machine reachable.",
        );
      }),
    ),
  ),
  Command.withSubcommands([
    connectLoginCommand,
    connectLinkCommand,
    connectPublishCommand,
    connectStatusCommand,
    connectUnlinkCommand,
    connectLogoutCommand,
  ]),
);
