/**
 * OpenCode2Provider — snapshot builders for the standalone `opencode2`
 * driver.
 *
 * Mirrors the Grok/Cursor snapshot shape: an initial pending snapshot for
 * registry boot, plus `checkOpenCode2ProviderStatus` for the managed refresh.
 * Both the local-binary and external-server paths probe through the shared
 * `../opencodeVersionProbe.ts` (`probeOpenCodeRuntime`). Model inventory
 * arrives via `../opencode2/OpenCode2Inventory.ts`
 * (`loadOpenCode2Inventory` + `flattenOpenCode2Models`) against the
 * instance's `OpenCode2Server` connection; the server memoizes its verified
 * connection, so status checks share it with the adapter. Skill/command
 * mapping reuses the v1 converters — the v2 inventory satisfies the same
 * `OpenCodeInventory` contract.
 *
 * @module provider/Layers/OpenCode2Provider
 */
import type { OpenCodeClient } from "@opencode/client/effect";
import type {
  CustomModelSetting,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HttpClient } from "effect/unstable/http";

import type { OpenCode2Settings } from "../OpenCode2Settings.ts";
import { OPENCODE2_DRIVER_KIND } from "../OpenCode2Settings.ts";
import {
  flattenOpenCode2Models,
  loadOpenCode2Inventory,
  type OpenCode2InventoryClient,
} from "../opencode2/OpenCode2Inventory.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import { type ProbedOpenCode, MINIMUM_OPENCODE2_VERSION } from "../opencodeVersionProbe.ts";
export { MINIMUM_OPENCODE2_VERSION };
import { openCodeRuntimeErrorDetail, type OpenCodeRuntimeError } from "../opencodeRuntime.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  openCodeCommandsToServerProviderSlashCommands,
  openCodeSkillsToServerProviderSkills,
} from "./OpenCodeProvider.ts";

export const OPENCODE2_PRESENTATION = {
  displayName: "OpenCode 2",
  showInteractionModeToggle: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

class OpenCode2ProbeError extends Data.TaggedError("OpenCode2ProbeError")<{
  readonly cause?: unknown;
  readonly detail: string;
}> {}

/**
 * Strip URL userinfo before a server URL reaches user-facing text: a URL
 * such as `https://user:secret@host` must never expose its embedded
 * credentials in snapshot `probe.message` strings. Non-URL input passes
 * through unchanged (so a malformed configured value still renders for
 * debugging, just without anything parsed as userinfo).
 */
export function redactOpenCode2ServerUrlUserinfo(serverUrl: string): string {
  const atIndex = serverUrl.lastIndexOf("@");
  if (atIndex < 0) {
    return serverUrl;
  }
  const schemeEnd = serverUrl.indexOf("://");
  if (schemeEnd < 0 || schemeEnd > atIndex) {
    return serverUrl;
  }
  const afterScheme = serverUrl.slice(schemeEnd + 3);
  const authorityEnd = afterScheme.search(/[?#/]/);
  const authority = authorityEnd < 0 ? afterScheme : afterScheme.slice(0, authorityEnd);
  const atInAuthority = authority.lastIndexOf("@");
  if (atInAuthority < 0) {
    return serverUrl;
  }
  const hostPort = authority.slice(atInAuthority + 1);
  const rest = authorityEnd < 0 ? "" : afterScheme.slice(authorityEnd);
  return `${serverUrl.slice(0, schemeEnd + 3)}${hostPort}${rest}`;
}

function normalizeProbeMessage(message: string): string | undefined {
  const trimmed = message.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (
    trimmed === "An error occurred in Effect.tryPromise" ||
    trimmed === "An error occurred in Effect.try"
  ) {
    return undefined;
  }
  return trimmed;
}

function normalizedErrorMessage(cause: unknown): string | undefined {
  if (cause instanceof OpenCode2ProbeError) {
    return normalizeProbeMessage(cause.detail);
  }
  if (!(cause instanceof Error)) {
    return undefined;
  }
  return normalizeProbeMessage(cause.message);
}

/**
 * Maps a shared-probe failure onto the snapshot's installed flag + message.
 * Structured after v1's `formatOpenCodeProbeError`: auth failures and
 * unreachable servers report installed (the binary/server exists but the
 * connection failed); a missing local binary reports not-installed.
 * Inventory-phase failures keep the probed version (the binary/server
 * answered the version gate) and name the inventory load; v1 reports the
 * phase the same way.
 */
function formatOpenCode2ProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly phase: "version" | "inventory";
  readonly serverUrl: string;
}): { readonly installed: boolean; readonly message: string } {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    if (
      lower.includes("401") ||
      lower.includes("403") ||
      lower.includes("unauthorized") ||
      lower.includes("forbidden")
    ) {
      return {
        installed: true,
        message: "OpenCode 2 server rejected authentication. Check the server URL and password.",
      };
    }
    if (
      lower.includes("econnrefused") ||
      lower.includes("enotfound") ||
      lower.includes("fetch failed") ||
      lower.includes("networkerror") ||
      lower.includes("timed out") ||
      lower.includes("timeout") ||
      lower.includes("socket hang up")
    ) {
      return {
        installed: true,
        message: `Couldn't reach the configured OpenCode 2 server at ${redactOpenCode2ServerUrlUserinfo(input.serverUrl)}. Check that the server is running and the URL is correct.`,
      };
    }
    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode 2 server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode 2 CLI (`opencode`) is not installed or not on PATH.",
    };
  }

  if (lower.includes("quarantine")) {
    return {
      installed: true,
      message:
        "macOS is blocking the OpenCode binary (quarantine). Run `xattr -d com.apple.quarantine $(which opencode)` to fix this.",
    };
  }

  if (lower.includes("invalid code signature") || lower.includes("corrupted")) {
    return {
      installed: true,
      message:
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted — try reinstalling OpenCode.",
    };
  }

  const failureLabel =
    input.phase === "inventory"
      ? "Failed to load OpenCode 2 provider inventory"
      : "Failed to execute OpenCode 2 CLI health check";
  return {
    installed: true,
    message: detail ? `${failureLabel}: ${detail}` : `${failureLabel}.`,
  };
}

function openCode2ModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings([], customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Narrow bridge from the generated `@opencode/client` Effect client to the
 * structural {@link OpenCode2InventoryClient} surface. Exported for the
 * driver, which reuses it for per-workspace (`snapshotForCwd`) inventory.
 * Each namespace's `list` is invoked with the status-check `cwd` as its
 * location; the promise-returning inventory shape wraps the Effect calls
 * with `Effect.runPromise` (no scope is needed — the calls are single HTTP
 * round trips).
 */
export function toOpenCode2InventoryClient(client: OpenCodeClient): OpenCode2InventoryClient {
  const runList = <T, E>(call: Effect.Effect<{ readonly data: ReadonlyArray<T> }, E>) =>
    Effect.runPromise(call);
  const withDirectory = (directory: string) => (directory ? { location: { directory } } : {});
  return {
    provider: {
      list: (location) =>
        runList(client.provider.list(withDirectory(location.location.directory))).then(
          ({ data }) => ({
            data: data.map((provider) => ({ id: String(provider.id), name: provider.name })),
          }),
        ),
    },
    model: {
      list: (location) =>
        runList(client.model.list(withDirectory(location.location.directory))).then(({ data }) => ({
          data: data.map((model) => ({
            modelID: String(model.id),
            providerID: String(model.providerID),
            name: model.name,
            enabled: model.enabled,
            variants: model.variants.map((variant) => ({ id: String(variant.id) })),
          })),
        })),
    },
    agent: {
      list: (location) =>
        runList(client.agent.list(withDirectory(location.location.directory))).then(({ data }) => ({
          data: data.map((agent) => ({
            id: String(agent.id),
            mode: agent.mode,
            hidden: agent.hidden,
            permissions: undefined,
          })),
        })),
    },
    skill: {
      list: (location) =>
        runList(client.skill.list(withDirectory(location.location.directory))).then(({ data }) => ({
          data: data.map((skill) => ({
            name: skill.name,
            path: String(skill.path),
          })),
        })),
    },
    command: {
      list: (location) =>
        runList(client.command.list(withDirectory(location.location.directory))).then(
          ({ data }) => ({
            data: data.map((command) => ({
              name: command.name,
              ...(command.description ? { description: command.description } : {}),
            })),
          }),
        ),
    },
  };
}

export function buildInitialOpenCode2ProviderSnapshot(
  settings: OpenCode2Settings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = openCode2ModelsFromSettings(settings.customModels);

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: OPENCODE2_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            settings.serverUrl.trim().length > 0
              ? "OpenCode 2 is disabled in T3 Code settings. A server URL is configured."
              : "OpenCode 2 is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking OpenCode 2 CLI availability...",
      },
    });
  });
}

/**
 * One instance's v2 runtime probe, remembered after the first success.
 * Settings changes rebuild the driver; `refresh` re-probes so an in-place
 * upgrade re-routes. A failed probe is never remembered. Unlike the shared
 * helper it keeps `R` (the driver's `HttpClient` for server probes) instead
 * of pinning it to `never`.
 */
export const makeOpenCode2RuntimeProbe = <E, R>(probe: Effect.Effect<ProbedOpenCode, E, R>) =>
  Effect.map(
    Cache.makeWith(() => probe, {
      capacity: 1,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    }),
    (cache) => ({ get: Cache.get(cache, undefined), refresh: Cache.refresh(cache, undefined) }),
  );

/**
 * `probeRuntime` is the driver's memoized version probe: `opencode --version`
 * for a local binary, the version endpoints for a configured server. The
 * status check refreshes it, so an in-place upgrade re-routes the instance.
 */
export const checkOpenCode2ProviderStatus = Effect.fn("checkOpenCode2ProviderStatus")(function* (
  settings: OpenCode2Settings,
  cwd: string,
  probeRuntime: Effect.Effect<ProbedOpenCode, OpenCodeRuntimeError>,
): Effect.fn.Return<ServerProviderDraft, never, OpenCode2Server.OpenCode2Server> {
  const server = yield* OpenCode2Server.OpenCode2Server;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = settings.customModels;
  const isExternalServer = settings.serverUrl.trim().length > 0;

  const fallback = (
    cause: unknown,
    version: string | null = null,
    phase: "version" | "inventory" = "version",
  ) => {
    const failure = formatOpenCode2ProbeError({
      cause,
      isExternalServer,
      phase,
      serverUrl: settings.serverUrl,
    });
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: failure.message,
      },
    });
  };

  if (!settings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode 2 is disabled in T3 Code settings. A server URL is configured."
          : "OpenCode 2 is disabled in T3 Code settings.",
      },
    });
  }

  const probedExit = yield* Effect.exit(
    probeRuntime.pipe(
      Effect.mapError(
        (cause) => new OpenCode2ProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
      ),
    ),
  );
  if (probedExit._tag === "Failure") return fallback(Cause.squash(probedExit.cause));
  const probed = probedExit.value;
  // An `opencode2` instance requires the 2.x line at or above the
  // pinned client floor: a v1 binary is stale, never a silent downgrade
  // to the v1 runtime.
  if (probed.generation === "v1") {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: true,
        version: probed.version,
        status: "error",
        auth: { status: "unknown" },
        message: `OpenCode v${probed.version} is a 1.x release. This instance requires OpenCode v${MINIMUM_OPENCODE2_VERSION} or newer — keep using the OpenCode (1.x) provider for it.`,
      },
    });
  }
  if (compareSemverVersions(probed.version, MINIMUM_OPENCODE2_VERSION) < 0) {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, EMPTY_CAPABILITIES),
      probe: {
        installed: true,
        version: probed.version,
        status: "error",
        auth: { status: "unknown" },
        message: `OpenCode v${probed.version} is too old. Upgrade to v${MINIMUM_OPENCODE2_VERSION} or newer.`,
      },
    });
  }

  const inventoryExit = yield* Effect.exit(
    server
      .withConnection((connection) =>
        loadOpenCode2Inventory(toOpenCode2InventoryClient(connection.client), cwd),
      )
      .pipe(
        Effect.mapError(
          (cause) => new OpenCode2ProbeError({ cause, detail: openCodeRuntimeErrorDetail(cause) }),
        ),
      ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), probed.version, "inventory");
  }

  const inventory = inventoryExit.value;
  const models = providerModelsFromSettings(
    flattenOpenCode2Models(inventory),
    customModels,
    EMPTY_CAPABILITIES,
  );
  const connectedCount = inventory.providerList.connected.length;
  return buildServerProvider({
    presentation: OPENCODE2_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    skills: openCodeSkillsToServerProviderSkills(inventory.skills),
    slashCommands: [
      COMPACT_SLASH_COMMAND,
      ...openCodeCommandsToServerProviderSlashCommands(inventory.commands).filter(
        (command) => command.name !== COMPACT_SLASH_COMMAND.name,
      ),
    ],
    probe: {
      installed: true,
      version: probed.version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode 2 server" : "OpenCode 2"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode 2 server, but it did not report any connected upstream providers."
            : "OpenCode 2 is available, but it did not report any connected upstream providers.",
    },
  });
});

/**
 * Background maintenance enrichment for an OpenCode 2 snapshot.
 *
 * Used by `OpenCode2Driver` as the `makeManagedServerProvider.enrichSnapshot`
 * hook: republishes update/version advisory metadata without performing any
 * model or capability discovery.
 */
export const enrichOpenCode2Snapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("OpenCode 2 version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};

export const OPENCODE2_DRIVER_SLUG = OPENCODE2_DRIVER_KIND;
