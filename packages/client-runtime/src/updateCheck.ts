// @effect-diagnostics globalTimers:off - Promise-based checks for React handlers, outside an Effect runtime.
import {
  type EnvironmentId,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerConfig,
  type ServerNpmRelease,
  type ServerProvider,
} from "@t3tools/contracts";
import { APP_NAME } from "@t3tools/shared/branding";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";

import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "./state/runtime.ts";

export type UpdateCheckResult =
  | { readonly status: "up-to-date" }
  | { readonly status: "available"; readonly version: string }
  | { readonly status: "error"; readonly reason: string };

export interface UpdateCheckItem {
  readonly subject: string;
  readonly result: UpdateCheckResult;
}

export interface UpdateCheckEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig: Pick<ServerConfig, "environment"> | null;
  /** The app's own check covers a server it runs. */
  readonly hostedByThisApp: boolean;
  readonly canManageProviders: boolean;
}

type Target<Input> = { readonly environmentId: EnvironmentId; readonly input: Input };

/** The `lookupNpmRelease` and `refreshProviders` environment commands. */
export interface UpdateCheckCommands {
  readonly lookupNpmRelease: (
    target: Target<{ readonly spec: "latest" | "nightly" }>,
  ) => Promise<AtomCommandResult<ServerNpmRelease | null, unknown>>;
  readonly refreshProviders: (
    target: Target<{ readonly refreshModels: true }>,
  ) => Promise<AtomCommandResult<{ readonly providers: ReadonlyArray<ServerProvider> }, unknown>>;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

const upToDate: UpdateCheckResult = { status: "up-to-date" };
const failed = (reason: string): UpdateCheckResult => ({ status: "error", reason });

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "The check failed.";
}

async function succeeded<A>(command: Promise<AtomCommandResult<A, unknown>>): Promise<A> {
  const result = await command;
  if (result._tag === "Success") return result.value;
  throw isAtomCommandInterrupted(result)
    ? new Error("The check was cancelled.")
    : squashAtomCommandFailure(result);
}

// A hung request must not hold the whole check, and its spinner, forever.
async function withTimeout<A>(request: Promise<A>, timeoutMs: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No answer after ${Math.round(timeoutMs / 1000)} seconds.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function checkServer(
  environment: UpdateCheckEnvironment,
  commands: UpdateCheckCommands,
  timeoutMs: number,
): Promise<UpdateCheckResult> {
  const server = environment.serverConfig?.environment;
  if (server === undefined) return failed("Its version is unknown.");
  const current = server.serverVersion;
  if (server.capabilities.npmReleaseLookup !== true) {
    return failed("This server is too old to check for updates. Update it manually.");
  }
  const channel = cliReleaseChannelOf(current);
  if (channel === "preview") return failed("Preview builds have no update track.");
  try {
    const latest = await withTimeout(
      succeeded(
        commands.lookupNpmRelease({
          environmentId: environment.environmentId,
          input: { spec: channel === "nightly" ? "nightly" : "latest" },
        }),
      ),
      timeoutMs,
    );
    if (latest === null) return failed(`No ${channel} release was found.`);
    return compareSemverVersions(latest.version, current) > 0
      ? { status: "available", version: latest.version }
      : upToDate;
  } catch (error) {
    return failed(reasonOf(error));
  }
}

/** Each provider's driver once; an update a broken or unsupported release would bring is no update. */
function providerUpdateItems(
  label: string,
  providers: ReadonlyArray<ServerProvider>,
): UpdateCheckItem[] {
  const available = new Map<ProviderDriverKind, string>();
  for (const provider of providers) {
    const advisory = provider.versionAdvisory;
    const latestStatus = provider.compatibilityAdvisory?.latestVersionStatus;
    if (
      provider.enabled &&
      advisory?.status === "behind_latest" &&
      advisory.latestVersion !== null &&
      latestStatus !== "broken" &&
      latestStatus !== "unsupported" &&
      !available.has(provider.driver)
    ) {
      available.set(provider.driver, advisory.latestVersion);
    }
  }
  if (available.size === 0) return [{ subject: `Providers on ${label}`, result: upToDate }];
  return [...available].map(([driver, version]) => ({
    subject: `${PROVIDER_DISPLAY_NAMES[driver] ?? driver} on ${label}`,
    result: { status: "available", version },
  }));
}

async function checkProviders(
  environment: UpdateCheckEnvironment,
  commands: UpdateCheckCommands,
  timeoutMs: number,
): Promise<UpdateCheckItem[]> {
  const subject = `Providers on ${environment.label}`;
  if (!environment.canManageProviders) {
    return [{ subject, result: failed("You do not have permission to manage them.") }];
  }
  try {
    const { providers } = await withTimeout(
      succeeded(
        commands.refreshProviders({
          environmentId: environment.environmentId,
          input: { refreshModels: true },
        }),
      ),
      timeoutMs,
    );
    return providerUpdateItems(environment.label, providers);
  } catch (error) {
    return [{ subject, result: failed(reasonOf(error)) }];
  }
}

/** Every environment's own server and its providers, in the order given. */
export async function checkEnvironmentUpdates(
  environments: ReadonlyArray<UpdateCheckEnvironment>,
  commands: UpdateCheckCommands,
): Promise<UpdateCheckItem[]> {
  const timeoutMs = commands.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const perEnvironment = await Promise.all(
    environments.map(async (environment): Promise<UpdateCheckItem[]> => {
      if (environment.connection.phase !== "connected") {
        return [{ subject: environment.label, result: failed("Not connected.") }];
      }
      const [server, providers] = await Promise.all([
        environment.hostedByThisApp ? null : checkServer(environment, commands, timeoutMs),
        checkProviders(environment, commands, timeoutMs),
      ]);
      return server === null
        ? providers
        : [{ subject: `${APP_NAME} on ${environment.label}`, result: server }, ...providers];
    }),
  );
  return perEnvironment.flat();
}

export interface UpdateCheckSummary {
  readonly tone: "available" | "error" | "up-to-date";
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
}

export function summarizeUpdateCheck(items: ReadonlyArray<UpdateCheckItem>): UpdateCheckSummary {
  const lines = items.map(({ subject, result }) =>
    result.status === "available"
      ? `${subject}: ${result.version} available`
      : result.status === "error"
        ? `${subject}: ${result.reason}`
        : `${subject}: up to date`,
  );
  if (items.length === 0) {
    return { tone: "error", title: "Nothing to check", lines: ["Connect to a server first."] };
  }
  if (items.some(({ result }) => result.status === "available")) {
    return { tone: "available", title: "Updates available", lines };
  }
  if (items.some(({ result }) => result.status === "error")) {
    return { tone: "error", title: "Could not check everything", lines };
  }
  return { tone: "up-to-date", title: "Everything is up to date", lines };
}
