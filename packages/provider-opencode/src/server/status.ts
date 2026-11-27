import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { createModelCapabilities, DEFAULT_VARIANT_CHOICE_ID } from "@t3tools/shared/model";
import {
  brokenVersionDetail,
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import type { ProbedOpenCode } from "./versionProbe.ts";
import type { Agent, ProviderListResponse } from "@opencode-ai/sdk/v2";
import { ServiceUnavailableError } from "@opencode/protocol/errors";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

const OPENCODE_PRESENTATION = {
  displayName: "OpenCode",
  showInteractionModeToggle: false,
} as const;

class OpenCodeProbeError extends Schema.TaggedError<OpenCodeProbeError>()("OpenCodeProbeError", {
  cause: Schema.optional(Schema.Defect()),
  detail: Schema.String,
}) {}

const isOpenCodeProbeError = Schema.is(OpenCodeProbeError);

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
  if (isOpenCodeProbeError(cause)) {
    return normalizeProbeMessage(cause.detail);
  }

  if (!(cause instanceof Error)) {
    return undefined;
  }

  return normalizeProbeMessage(cause.message);
}

function formatOpenCodeProbeError(input: {
  readonly cause: unknown;
  readonly isExternalServer: boolean;
  readonly phase: "version" | "inventory";
  readonly serverUrl: string;
}): {
  readonly installed: boolean;
  readonly message: string;
  readonly authStatus?: "unauthenticated";
} {
  const detail = normalizedErrorMessage(input.cause);
  const lower = detail?.toLowerCase() ?? "";

  if (input.isExternalServer) {
    // Bare auth-code digits can be part of the endpoint's port or path.
    if (
      /(?:^|\s)(?:status(?:\s+code)?(?:\s*[:=]\s*|\s+)|http(?:\/\d(?:\.\d)?)?\s+)(?:401|403)\b/.test(
        lower,
      ) ||
      /\b(?:unauthorized|forbidden)\b/.test(lower)
    ) {
      return {
        installed: true,
        authStatus: "unauthenticated",
        message: "OpenCode server rejected authentication. Check the server URL and password.",
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
        message: `Couldn't reach the configured OpenCode server at ${input.serverUrl}. Check that the server is running and the URL is correct.`,
      };
    }

    return {
      installed: true,
      message: detail ?? "Failed to connect to the configured OpenCode server.",
    };
  }

  if (lower.includes("enoent") || lower.includes("notfound")) {
    return {
      installed: false,
      message: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
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
        "macOS killed the OpenCode process due to an invalid code signature. The binary may be corrupted. Try reinstalling OpenCode.",
    };
  }

  const failureLabel =
    input.phase === "inventory"
      ? "Failed to load OpenCode provider inventory"
      : "Failed to execute OpenCode CLI health check";
  return {
    installed: true,
    message: detail ? `${failureLabel}: ${detail}` : `${failureLabel}.`,
  };
}

// The status check owns the span; keep handled failures visible without adding another span.
const logDiscoveryFailure = Effect.fnUntraced(function* (input: {
  readonly phase: "version" | "inventory" | "models";
  readonly isExternalServer: boolean;
  readonly version?: string;
  readonly cause?: Cause.Cause<unknown>;
}) {
  const outcome = input.cause ? "failed" : "empty";
  const attributes = {
    provider: "opencode",
    phase: input.phase,
    outcome,
    serverMode: input.isExternalServer ? "external" : "managed",
    ...(input.version === undefined ? {} : { version: input.version }),
  };
  yield* Effect.annotateCurrentSpan({
    "discovery.phase": input.phase,
    "discovery.outcome": outcome,
  });
  yield* (
    input.cause
      ? Effect.logWarning("OpenCode discovery failed", input.cause)
      : Effect.logWarning("OpenCode discovery failed")
  ).pipe(Effect.annotateLogs(attributes));
});

function titleCaseSlug(value: string): string {
  const segments: Array<string> = [];
  for (const segment of value.split(/[-_/]+/)) {
    if (segment.length > 0) {
      segments.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  return segments.join(" ");
}

function reasoningVariantLabel(value: string): string {
  return value === "xhigh" ? "Extra High" : titleCaseSlug(value);
}

function inferDefaultVariant(
  providerID: string,
  variants: ReadonlyArray<string>,
): string | undefined {
  if (variants.length === 1) {
    return variants[0];
  }
  if (providerID === "anthropic" || providerID.startsWith("google")) {
    return variants.includes("high") ? "high" : undefined;
  }
  if (providerID === "openai" || providerID === "opencode" || providerID === "opencode-go") {
    return variants.includes("medium") ? "medium" : variants.includes("high") ? "high" : undefined;
  }
  return undefined;
}

/** Without an inferable default, a Default choice lets the user go back to sending no variant. */
function openCodeVariantDescriptors(
  providerID: string,
  variants: ReadonlyArray<string>,
): Array<ProviderOptionDescriptor> {
  if (variants.length === 0) return [];
  const inferred = inferDefaultVariant(providerID, variants);
  const options = variants.map((id) => ({
    id,
    label: reasoningVariantLabel(id),
    ...(id === inferred ? { isDefault: true } : {}),
  }));
  return [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options:
        inferred === undefined
          ? [{ id: DEFAULT_VARIANT_CHOICE_ID, label: "Default" }, ...options]
          : options,
      currentValue: inferred ?? DEFAULT_VARIANT_CHOICE_ID,
    },
  ];
}

function inferDefaultAgent(agents: ReadonlyArray<Agent>): string | undefined {
  return agents.find((agent) => agent.name === "build")?.name ?? agents[0]?.name ?? undefined;
}

const DEFAULT_OPENCODE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "variant",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
        { id: "xhigh", label: "Extra High" },
      ],
      currentValue: "medium",
    },
    {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [
        { id: "build", label: "Build", isDefault: true },
        { id: "plan", label: "Plan" },
      ],
      currentValue: "build",
    },
  ],
});

function openCodeCapabilitiesForModel(input: {
  readonly providerID: string;
  readonly model: ProviderListResponse["all"][number]["models"][string];
  readonly agents: ReadonlyArray<Agent>;
}): ModelCapabilities {
  const variantValues = Object.keys(input.model.variants ?? {});
  const primaryAgents = input.agents.filter(
    (agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"),
  );
  const defaultAgent = inferDefaultAgent(primaryAgents);
  const agentOptions = primaryAgents.map((agent) =>
    defaultAgent === agent.name
      ? { id: agent.name, label: titleCaseSlug(agent.name), isDefault: true as const }
      : { id: agent.name, label: titleCaseSlug(agent.name) },
  );
  return createModelCapabilities({
    optionDescriptors: [
      ...openCodeVariantDescriptors(input.providerID, variantValues),
      ...(agentOptions.length > 0
        ? [
            {
              id: "agent",
              label: "Agent",
              type: "select" as const,
              options: agentOptions,
              ...(defaultAgent ? { currentValue: defaultAgent } : {}),
            },
          ]
        : []),
    ],
  });
}

interface OpenCodeRelease {
  readonly providerID: string;
  readonly id: string;
  readonly family?: string | undefined;
  readonly released?: number | undefined;
  readonly deprecated?: boolean | undefined;
  /** Base input and output price, which a model size keeps when it is renamed. */
  readonly price?: string | undefined;
}

export const openCodePrice = (cost: { readonly input: number; readonly output: number }) =>
  `${cost.input}/${cost.output}`;

/**
 * `claude-opus-5` and `claude-opus-5-5` are one release line; `gemini-4-carbon` is another.
 * A parameter count such as `8b` or `70b` names a size, so it stays in the line.
 */
const releaseLine = (id: string) =>
  id
    .toLowerCase()
    .split(/[-_]/)
    .map((token) => (/^\d+(\.\d+)?[bm]$/.test(token) ? token : token.replace(/[\d.]+/g, "")))
    .join("");

/**
 * One OpenCode family can hold several model sizes, such as Gemini 4 Carbon and Hydrogen.
 * A release is legacy when deprecated, or when its family in the same sub-provider has a
 * newer active release whose id differs only in version or that is sold at the same price.
 */
function markOpenCodeLegacy(
  entries: ReadonlyArray<{
    readonly model: ServerProviderModel;
    readonly release: OpenCodeRelease;
  }>,
): Array<ServerProviderModel> {
  const familyKey = ({ providerID, family }: OpenCodeRelease) =>
    family ? `${providerID}/${family}` : undefined;
  const active = new Map<
    string,
    Array<{ readonly released: number; readonly line: string; readonly price: string | undefined }>
  >();
  for (const { release } of entries) {
    const key = familyKey(release);
    if (key === undefined || release.released === undefined || release.deprecated) continue;
    const releases = active.get(key) ?? [];
    releases.push({
      released: release.released,
      line: releaseLine(release.id),
      price: release.price,
    });
    active.set(key, releases);
  }
  return entries.map(({ model, release }) => {
    const key = familyKey(release);
    const { released, price } = release;
    const line = releaseLine(release.id);
    const superseded =
      key !== undefined &&
      released !== undefined &&
      (active.get(key) ?? []).some(
        (other) =>
          other.released > released &&
          (other.line === line || (price !== undefined && other.price === price)),
      );
    return release.deprecated || superseded ? { ...model, isLegacy: true } : model;
  });
}

function flattenOpenCodeModels(
  input: Pick<OpenCodeRuntime.OpenCodeInventory, "providerList" | "agents">,
): ReadonlyArray<ServerProviderModel> {
  const connected = new Set(input.providerList.connected);
  const entries: Array<{ model: ServerProviderModel; release: OpenCodeRelease }> = [];

  for (const provider of input.providerList.all) {
    if (!connected.has(provider.id)) {
      continue;
    }

    for (const model of Object.values(provider.models)) {
      const name = nonEmptyTrimmed(model.name);
      if (!name) {
        continue;
      }

      const subProvider = nonEmptyTrimmed(provider.name);
      const released = Date.parse(model.release_date);
      entries.push({
        model: {
          slug: `${provider.id}/${model.id}`,
          name,
          ...(subProvider ? { subProvider } : {}),
          isCustom: false,
          capabilities: openCodeCapabilitiesForModel({
            providerID: provider.id,
            model,
            agents: input.agents,
          }),
        },
        release: {
          providerID: provider.id,
          id: model.id,
          family: model.family,
          released: Number.isNaN(released) ? undefined : released,
          deprecated: model.status === "deprecated",
          price: model.cost ? openCodePrice(model.cost) : undefined,
        },
      });
    }
  }

  return markOpenCodeLegacy(entries).toSorted((left, right) => left.name.localeCompare(right.name));
}

/** Undefined when OpenCode lists no models, so callers can keep the catalog they have. */
export function openCodeProviderModels(
  settings: Pick<OpenCodeSettings, "customModels">,
  catalog: Pick<OpenCodeRuntime.OpenCodeInventory, "providerList" | "agents">,
): ReadonlyArray<ServerProviderModel> | undefined {
  const models = flattenOpenCodeModels(catalog);
  return models.length === 0
    ? undefined
    : providerModelsFromSettings(
        models,
        settings.customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      );
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function openCodeSkillsToServerProviderSkills(
  input: OpenCodeRuntime.OpenCodeInventory["skills"] | undefined,
): ReadonlyArray<ServerProviderSkill> {
  const skills: ServerProviderSkill[] = [];
  for (const skill of input ?? []) {
    const name = trimOptional(skill.name);
    const path = trimOptional(skill.location);
    if (!name || !path) {
      continue;
    }

    const description = trimOptional(skill.description);
    skills.push({
      name,
      path,
      enabled: true,
      ...(description ? { description, shortDescription: description } : {}),
    });
  }

  return skills.toSorted((left, right) => left.name.localeCompare(right.name));
}

export function openCodeCommandsToServerProviderSlashCommands(
  input: OpenCodeRuntime.OpenCodeInventory["commands"],
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const names = new Set([COMPACT_SLASH_COMMAND.name]);
  for (const command of input ?? []) {
    const name = trimOptional(command.name);
    if (!name || names.has(name) || command.source === "skill") continue;
    names.add(name);
    const description = trimOptional(command.description);
    const hint = trimOptional(command.hints.join(" "));
    commands.push({
      name,
      ...(description ? { description } : {}),
      ...(hint ? { input: { hint } } : {}),
    });
  }
  return commands;
}

export const makePendingOpenCodeProvider = Effect.fn(
  "OpencodeProviderStatus.makePendingOpenCodeProvider",
)(function* (openCodeSettings: OpenCodeSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = providerModelsFromSettings(
    [],
    openCodeSettings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message:
          openCodeSettings.serverUrl.trim().length > 0
            ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
            : "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  return buildServerProvider({
    presentation: OPENCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "OpenCode provider status has not been checked in this session yet.",
    },
  });
});

export interface OpenCode2Model extends OpenCodeRelease {
  readonly name: string;
  readonly providerName?: string;
  readonly variants: ReadonlyArray<{ readonly id: string }>;
}

// Sub-provider names distinguish overlapping catalog entries.
function subProviderLabelFor(input: {
  readonly providerID: string;
  readonly providerName?: string;
}): string | undefined {
  const label = nonEmptyTrimmed(input.providerName) ?? input.providerID;
  return label.toLowerCase() === OPENCODE_PRESENTATION.displayName.toLowerCase()
    ? undefined
    : label;
}

const catalogFingerprint = (models: ReadonlyArray<OpenCode2Model>) =>
  models
    .map((model) =>
      JSON.stringify([
        model.providerID,
        model.id,
        model.name,
        model.providerName,
        model.variants.map((variant) => variant.id).toSorted(),
      ]),
    )
    .toSorted()
    .join("\n");

// A cold OpenCode 2.2.5 503s model reads for about a minute while its location plugins activate.
const PLUGIN_ACTIVATION_DEADLINE = "2 minutes";

const isServiceUnavailable = Schema.is(ServiceUnavailableError);
const isActivatingPlugins = (error: unknown): boolean =>
  OpenCodeRuntime.isOpenCodeRuntimeError(error)
    ? isActivatingPlugins(error.cause)
    : isServiceUnavailable(error) && error.service === "plugin";

/** A cold server can list a partial catalog; two agreeing reads reduce that startup race. */
const settleOpenCode2Catalog = <E>(
  list: Effect.Effect<ReadonlyArray<OpenCode2Model>, E>,
  first?: ReadonlyArray<OpenCode2Model>,
) =>
  Effect.suspend(() => {
    let previous = first && first.length > 0 ? catalogFingerprint(first) : undefined;
    return (first ? Effect.delay(list, "250 millis") : list).pipe(
      Effect.repeat({
        until: (models) => {
          const fingerprint = models.length > 0 ? catalogFingerprint(models) : undefined;
          const settled = fingerprint !== undefined && fingerprint === previous;
          previous = fingerprint;
          return settled;
        },
        schedule: Schedule.spaced("250 millis"),
      }),
    );
  });

const OPENCODE_2_CATALOG_SETTLE_TIMEOUT_MS = 5_000;

export const makeOpenCode2ModelLoader = <E>(
  list: Effect.Effect<ReadonlyArray<OpenCode2Model>, E>,
  environment?: NodeJS.ProcessEnv,
) =>
  Effect.sync(() => {
    let lastLoaded: ReadonlyArray<OpenCode2Model> = [];
    return Effect.suspend(() => {
      let latest: ReadonlyArray<OpenCode2Model> = [];
      const tracked = list.pipe(
        Effect.tap((models) =>
          Effect.sync(() => {
            if (models.length > 0) latest = models;
          }),
        ),
      );
      // The first read can include a cold server start, so only settling shares the budget.
      // Each retry borrows the managed server, so retries well inside its idle TTL keep it alive.
      return tracked.pipe(
        Effect.retry({ while: isActivatingPlugins, schedule: Schedule.spaced("1 second") }),
        Effect.timeoutOption(PLUGIN_ACTIVATION_DEADLINE),
        Effect.flatMap((first) =>
          Option.isNone(first)
            ? Effect.succeedNone
            : settleOpenCode2Catalog(tracked, first.value).pipe(
                Effect.timeoutOption(
                  resolveProviderProbeTimeoutMs(
                    "opencode",
                    OPENCODE_2_CATALOG_SETTLE_TIMEOUT_MS,
                    environment,
                  ),
                ),
              ),
        ),
        Effect.catch((error) =>
          latest.length > 0 ? Effect.succeedSome(latest) : Effect.fail(error),
        ),
        Effect.map((loaded) => {
          // Fresh progress may still be partial, but a warm cache must not freeze slow catalogs.
          if (loaded._tag === "Some") lastLoaded = loaded.value;
          else if (latest.length > 0) lastLoaded = latest;
          return lastLoaded;
        }),
      );
    });
  });

/** None when the reads fail or never agree, so a partial catalog never passes for a settled one. */
export const readSettledOpenCode2Catalog = <E>(
  list: Effect.Effect<ReadonlyArray<OpenCode2Model>, E>,
  environment?: NodeJS.ProcessEnv,
) =>
  settleOpenCode2Catalog(list).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("opencode", OPENCODE_2_CATALOG_SETTLE_TIMEOUT_MS, environment),
    ),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<OpenCode2Model>>()),
  );

// The registry keeps this many per-directory snapshots; older directories need no watch.
const WATCHED_DIRECTORIES = 16;

interface WatchedCatalog {
  readonly read: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>;
  previous: string | undefined;
}

/**
 * OpenCode serves a startup snapshot until discovery ends and only `model.updated` says when, so
 * no wait proves a catalog complete. The watch re-reads after each followed read and each change
 * while the server's event stream lasts, borrowing nothing so a managed server still idles out.
 */
export const makeOpenCode2CatalogWatch = Effect.fn(
  "OpencodeProviderStatus.makeOpenCode2CatalogWatch",
)(function* (environment?: NodeJS.ProcessEnv) {
  const scope = yield* Effect.scope;
  const latest = yield* SubscriptionRef.make<ReadonlyArray<OpenCode2Model> | undefined>(undefined);
  const rescans = yield* Queue.unbounded<string, Cause.Done>();
  yield* Effect.addFinalizer(() => Queue.end(rescans));
  const reads = yield* Queue.sliding<void>(1);
  let following:
    | {
        readonly server: string;
        machine: WatchedCatalog | undefined;
        readonly directories: Map<string, WatchedCatalog>;
      }
    | undefined;
  const reread = (
    watched: WatchedCatalog,
    changed: (catalog: ReadonlyArray<OpenCode2Model>) => Effect.Effect<unknown>,
    read: Effect.Effect<
      ReadonlyArray<OpenCode2Model>,
      OpenCodeRuntime.OpenCodeRuntimeError
    > = watched.read,
  ) =>
    read.pipe(
      Effect.flatMap((catalog) => {
        const fingerprint = catalog.length > 0 ? catalogFingerprint(catalog) : undefined;
        if (fingerprint === undefined || fingerprint === watched.previous) return Effect.void;
        watched.previous = fingerprint;
        return changed(catalog);
      }),
      // A stopped server fails every read; that must not discard the catalog it had listed.
      Effect.retry({ times: 3, schedule: Schedule.spaced("1 second") }),
      // Nothing else bounds this read, and one that hangs would hold every later change.
      Effect.timeout("30 seconds"),
      Effect.ignore,
    );
  return {
    /** The newest machine catalog the watch read; undefined when the last check knows better. */
    changes: SubscriptionRef.changes(latest),
    /** Directories whose catalog no longer matches the one their scan was given. */
    rescans: Stream.fromQueue(rescans),
    /**
     * Call beside each catalog read. `read` must not borrow the server. A `directory` read
     * reports the catalog its scan settled on, if any, and is rescanned once that changes.
     */
    follow: <E, SE>(
      server: string,
      subscribe: Effect.Effect<Stream.Stream<{ readonly type: string }, SE>, E, Scope.Scope>,
      read: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>,
      directory?: { readonly cwd: string; readonly settled?: ReadonlyArray<OpenCode2Model> },
    ) =>
      Effect.suspend(() => {
        const started = following?.server !== server;
        const watching = started
          ? { server, machine: undefined, directories: new Map<string, WatchedCatalog>() }
          : following!;
        following = watching;
        if (directory === undefined) {
          watching.machine = { read, previous: watching.machine?.previous };
        } else {
          const { cwd, settled } = directory;
          const previous = settled?.length
            ? catalogFingerprint(settled)
            : watching.directories.get(cwd)?.previous;
          watching.directories.delete(cwd);
          watching.directories.set(cwd, { read, previous });
          for (const oldest of watching.directories.keys()) {
            if (watching.directories.size <= WATCHED_DIRECTORIES) break;
            watching.directories.delete(oldest);
          }
        }
        const requested = Queue.offer(reads, undefined).pipe(Effect.asVoid);
        if (!started) return requested;
        const rereadAll = Effect.suspend(() =>
          Effect.forEach(
            [
              ...(watching.machine
                ? [reread(watching.machine, (catalog) => SubscriptionRef.set(latest, catalog))]
                : []),
              ...Array.from(watching.directories, ([cwd, watched]) =>
                reread(watched, () => Queue.offer(rescans, cwd)),
              ),
            ],
            (effect) => effect,
            { concurrency: 4, discard: true },
          ),
        );
        // A new server lists its startup snapshot first; nothing else reads it unless a check did.
        const settleMachine = Effect.suspend(() => {
          const machine = watching.machine;
          return machine === undefined
            ? Effect.void
            : reread(
                machine,
                (catalog) => SubscriptionRef.set(latest, catalog),
                readSettledOpenCode2Catalog(machine.read, environment).pipe(
                  Effect.map(Option.getOrElse((): ReadonlyArray<OpenCode2Model> => [])),
                ),
              );
        });
        const watch = subscribe.pipe(
          Effect.tap(() => settleMachine),
          Effect.flatMap((events) =>
            events.pipe(
              Stream.filter((event) => event.type === "model.updated"),
              Stream.merge(Stream.fromQueue(reads), { haltStrategy: "left" }),
              // OpenCode announces one change as a burst of events.
              Stream.debounce("250 millis"),
              Stream.runForEach(() => rereadAll),
              Effect.ignore,
            ),
          ),
          // Unwatched, a catalog kept from an earlier server would override every later check.
          Effect.catch(() => SubscriptionRef.set(latest, undefined)),
          Effect.scoped,
          Effect.ensuring(
            Effect.sync(() => {
              if (following === watching) following = undefined;
            }),
          ),
        );
        return requested.pipe(Effect.andThen(Effect.forkIn(watch, scope)), Effect.asVoid);
      }),
  };
});

const openCode2ReadyMessage = (version: string, count: number) =>
  `OpenCode ${version} lists ${count} model${count === 1 ? "" : "s"}.`;

/** A catalog read after the check reports the same health the check would have. */
export const withOpenCode2Catalog = (
  snapshot: ServerProvider,
  settings: Pick<OpenCodeSettings, "customModels">,
  catalog: ReadonlyArray<OpenCode2Model>,
): ServerProvider =>
  snapshot.version === null || snapshot.status === "error" || snapshot.status === "disabled"
    ? snapshot
    : {
        ...snapshot,
        status: "ready",
        auth: { ...snapshot.auth, status: "authenticated" },
        message: openCode2ReadyMessage(snapshot.version, catalog.length),
        models: openCode2ProviderModels(settings, catalog),
      };

export interface OpenCode2Workspace {
  readonly skills: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly description?: string | undefined;
  }>;
  readonly commands: ReadonlyArray<{
    readonly name: string;
    readonly description?: string | undefined;
  }>;
}

/**
 * Runs `onScanned` for each location whose scan ends, which OpenCode announces once, after loading
 * the location, as `command.updated` plus `skill.updated`.
 */
export const followOpenCode2Scans = <E>(
  events: Stream.Stream<
    { readonly type: string; readonly location?: { readonly directory?: string } | undefined },
    E
  >,
  onScanned: (directory: string) => Effect.Effect<void>,
) => {
  const pending = new Map<string, Set<string>>();
  return events.pipe(
    Stream.runForEach((event) => {
      const directory = event.location?.directory;
      if (directory === undefined) return Effect.void;
      if (event.type !== "command.updated" && event.type !== "skill.updated") return Effect.void;
      const seen = pending.get(directory) ?? new Set<string>();
      pending.set(directory, seen.add(event.type));
      if (seen.size < 2) return Effect.void;
      pending.delete(directory);
      return onScanned(directory);
    }),
    Effect.ignore,
  );
};

/**
 * Until its scan ends a location lists only built-ins, even once the server lists it as loaded,
 * and nothing but the scan's end tells the two apart. Unless the caller saw that scan end, read to
 * boot the location, wait for its scan (`scanned` must listen before `read`), and read again.
 */
export const loadOpenCode2Workspace = Effect.fn("OpencodeProviderStatus.loadOpenCode2Workspace")(
  function* <E>(
    read: Effect.Effect<OpenCode2Workspace, E>,
    scanned: Effect.Effect<void>,
    sawScan: boolean,
    environment?: NodeJS.ProcessEnv,
  ) {
    const first = yield* read;
    if (sawScan) return first;
    yield* scanned.pipe(
      Effect.timeoutOption(resolveProviderProbeTimeoutMs("opencode", 10_000, environment)),
    );
    return yield* read;
  },
);

export function openCode2SkillsToServerProviderSkills(
  skills: OpenCode2Workspace["skills"],
): ReadonlyArray<ServerProviderSkill> {
  return skills
    .map((skill) => {
      const description = trimOptional(skill.description);
      return {
        name: skill.id,
        path: skill.path,
        enabled: true,
        ...(skill.name === skill.id ? {} : { displayName: skill.name }),
        ...(description ? { description, shortDescription: description } : {}),
      };
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export function openCode2CommandsToServerProviderSlashCommands(
  commands: OpenCode2Workspace["commands"],
): ReadonlyArray<ServerProviderSlashCommand> {
  const slashCommands: ServerProviderSlashCommand[] = [COMPACT_SLASH_COMMAND];
  const names = new Set([COMPACT_SLASH_COMMAND.name]);
  for (const command of commands) {
    const name = trimOptional(command.name);
    if (!name || names.has(name)) continue;
    names.add(name);
    const description = trimOptional(command.description);
    slashCommands.push({ name, ...(description ? { description } : {}) });
  }
  return slashCommands;
}

// OpenCode has no reviewer; Auto asks like Supervised.
const OPENCODE_2_PRESENTATION = {
  ...OPENCODE_PRESENTATION,
  showInteractionModeToggle: true,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "auto", "full-access"],
} as const;

function openCode2ModelCapabilities(model: OpenCode2Model): ModelCapabilities {
  return createModelCapabilities({
    optionDescriptors: openCodeVariantDescriptors(
      model.providerID,
      model.variants.map((variant) => variant.id),
    ),
  });
}

export function openCode2ProviderModels(
  settings: Pick<OpenCodeSettings, "customModels">,
  catalog: ReadonlyArray<OpenCode2Model>,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    markOpenCodeLegacy(
      catalog.map((model) => {
        const subProvider = subProviderLabelFor(model);
        return {
          model: {
            slug: `${model.providerID}/${model.id}`,
            name: model.name,
            ...(subProvider ? { subProvider } : {}),
            isCustom: false,
            capabilities: openCode2ModelCapabilities(model),
          },
          release: model,
        };
      }),
    ).toSorted((left, right) => left.name.localeCompare(right.name)),
    settings.customModels,
    DEFAULT_OPENCODE_MODEL_CAPABILITIES,
  );
}

const checkOpenCode2 = Effect.fn("checkOpenCode2")(function* (
  settings: OpenCodeSettings,
  version: string,
  checkedAt: string,
  loadModels: Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCodeRuntime.OpenCodeRuntimeError>,
) {
  const result = yield* Effect.exit(loadModels);
  const probe = (status: "ready" | "warning" | "error", message: string) => ({
    installed: true,
    version,
    status,
    auth: { status: status === "ready" ? ("authenticated" as const) : ("unknown" as const) },
    message,
  });
  if (result._tag === "Failure") {
    yield* logDiscoveryFailure({
      phase: "models",
      isExternalServer: settings.serverUrl.trim().length > 0,
      version,
      cause: result.cause,
    });
    return buildServerProvider({
      presentation: OPENCODE_2_PRESENTATION,
      enabled: true,
      checkedAt,
      models: providerModelsFromSettings(
        [],
        settings.customModels,
        DEFAULT_OPENCODE_MODEL_CAPABILITIES,
      ),
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe: probe("error", "OpenCode could not load its model list."),
    });
  }
  if (result.value.length === 0) {
    yield* logDiscoveryFailure({
      phase: "models",
      isExternalServer: settings.serverUrl.trim().length > 0,
      version,
    });
  }
  return buildServerProvider({
    presentation: OPENCODE_2_PRESENTATION,
    enabled: true,
    checkedAt,
    models: openCode2ProviderModels(settings, result.value),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe:
      result.value.length > 0
        ? probe("ready", openCode2ReadyMessage(version, result.value.length))
        : probe("warning", "OpenCode 2 is running, but it did not list any models yet."),
  });
});

export const checkOpenCodeProviderStatus = Effect.fn("checkOpenCodeProviderStatus")(function* (
  openCodeSettings: OpenCodeSettings,
  cwd: string,
  probeRuntime: Effect.Effect<ProbedOpenCode, OpenCodeRuntime.OpenCodeRuntimeError>,
  loadOpenCode2Models: Effect.Effect<
    ReadonlyArray<OpenCode2Model>,
    OpenCodeRuntime.OpenCodeRuntimeError
  >,
  environment?: NodeJS.ProcessEnv,
  compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  OpenCodeRuntime.OpenCodeRuntime | OpenCodeServerOwner.OpenCodeServerOwner
> {
  const openCodeRuntime = yield* OpenCodeRuntime.OpenCodeRuntime;
  const serverOwner = yield* OpenCodeServerOwner.OpenCodeServerOwner;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCodeSettings.customModels;
  const isExternalServer = openCodeSettings.serverUrl.trim().length > 0;

  const fallback = (
    cause: unknown,
    version: string | null = null,
    phase: "version" | "inventory" = "version",
  ) => {
    const failure = formatOpenCodeProbeError({
      cause,
      isExternalServer,
      phase,
      serverUrl: openCodeSettings.serverUrl,
    });
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: openCodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: failure.installed,
        version,
        status: "error",
        auth: { status: failure.authStatus ?? "unknown" },
        message: failure.message,
      },
    });
  };

  if (!openCodeSettings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode is disabled in T3 Code settings. A server URL is configured."
          : "OpenCode is disabled in T3 Code settings.",
      },
    });
  }

  const probedExit = yield* Effect.exit(
    probeRuntime.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeProbeError({
            cause,
            detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
          }),
      ),
    ),
  );
  if (probedExit._tag === "Failure") {
    yield* logDiscoveryFailure({ phase: "version", isExternalServer, cause: probedExit.cause });
    return fallback(Cause.squash(probedExit.cause));
  }
  const probed = probedExit.value;
  if (probed.generation === "v2") {
    return yield* checkOpenCode2(openCodeSettings, probed.version, checkedAt, loadOpenCode2Models);
  }
  const refuseBroken = Effect.fnUntraced(function* (detected: string) {
    const broken = brokenVersionDetail({
      name: "OpenCode",
      version: detected,
      advisory: yield* compatibility(ProviderDriverKind.make("opencode"), detected),
    });
    return broken === undefined
      ? undefined
      : buildServerProvider({
          presentation: OPENCODE_PRESENTATION,
          enabled: openCodeSettings.enabled,
          checkedAt,
          models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES),
          probe: {
            installed: true,
            version: detected,
            status: "error",
            auth: { status: "unknown" },
            message: broken,
          },
        });
  });
  const refused = yield* refuseBroken(probed.version);
  if (refused !== undefined) return refused;

  const installedVersion = isExternalServer ? {} : { installedVersion: probed.version };
  let version = probed.version;
  const loadInventory = Effect.fnUntraced(function* (server: {
    readonly url: string;
    readonly serverPassword?: string;
    readonly version: string;
  }) {
    // Preserve the helper's version even when its inventory request fails.
    version = server.version;
    return yield* openCodeRuntime.loadOpenCodeInventory(
      openCodeRuntime.createOpenCodeSdkClient({
        baseUrl: server.url,
        directory: cwd,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
      }),
    );
  });
  const inventoryEffect = isExternalServer
    ? openCodeRuntime
        .connectToOpenCodeServer({
          binaryPath: openCodeSettings.binaryPath,
          directory: cwd,
          serverUrl: openCodeSettings.serverUrl,
          ...(settingsSecretLiteral(openCodeSettings.serverPassword)
            ? { serverPassword: settingsSecretLiteral(openCodeSettings.serverPassword) }
            : {}),
          ...(environment !== undefined ? { environment } : {}),
        })
        .pipe(Effect.flatMap(loadInventory), Effect.scoped)
    : serverOwner.withServer(loadInventory);
  const inventoryExit = yield* Effect.exit(
    inventoryEffect.pipe(
      Effect.mapError(
        (cause) =>
          new OpenCodeProbeError({
            cause,
            detail: OpenCodeRuntime.openCodeRuntimeErrorDetail(cause),
          }),
      ),
    ),
  );
  // The server that answered can differ from the CLI the probe ran.
  const refusedServer = version === probed.version ? undefined : yield* refuseBroken(version);
  if (refusedServer !== undefined) return { ...refusedServer, ...installedVersion };
  if (inventoryExit._tag === "Failure") {
    yield* logDiscoveryFailure({
      phase: "inventory",
      isExternalServer,
      version,
      cause: inventoryExit.cause,
    });
    return {
      ...fallback(Cause.squash(inventoryExit.cause), version, "inventory"),
      ...installedVersion,
    };
  }

  const catalogModels = openCodeProviderModels(openCodeSettings, inventoryExit.value);
  const models =
    catalogModels ??
    providerModelsFromSettings([], customModels, DEFAULT_OPENCODE_MODEL_CAPABILITIES);
  const skills = openCodeSkillsToServerProviderSkills(inventoryExit.value.skills);
  const connectedCount = inventoryExit.value.providerList.connected.length;
  const catalogReady = connectedCount > 0 && catalogModels !== undefined;
  if (connectedCount > 0 && catalogModels === undefined) {
    yield* logDiscoveryFailure({ phase: "inventory", isExternalServer, version });
  }
  return {
    ...buildServerProvider({
      presentation: OPENCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      skills,
      slashCommands: openCodeCommandsToServerProviderSlashCommands(inventoryExit.value.commands),
      probe: {
        installed: true,
        version,
        status: catalogReady ? "ready" : "warning",
        auth: {
          status: catalogReady ? "authenticated" : "unknown",
          type: "opencode",
        },
        message:
          connectedCount > 0 && !catalogReady
            ? "OpenCode upstream providers are connected, but it did not list any models yet."
            : connectedCount > 0
              ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode server" : "OpenCode"}.`
              : isExternalServer
                ? "Connected to the configured OpenCode server, but it did not report any connected upstream providers."
                : "OpenCode is available, but it did not report any connected upstream providers.",
      },
    }),
    ...installedVersion,
  };
});
