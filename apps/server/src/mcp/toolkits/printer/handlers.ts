import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
  PrinterToolUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import { imageDimensions } from "../../../printer/PrinterAdapter.ts";
import * as PrinterService from "../../../printer/PrinterService.ts";
import { MAX_PRINTER_SNAPSHOT_BYTES } from "../../../printer/PrinterUrlGuard.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  PrinterCameraSnapshotTool,
  PrinterListTool,
  PrinterSnapshotToolkit,
  PrinterStandardToolkit,
  PrinterStatusTool,
  type PrinterToolkit,
} from "./tools.ts";

const PEER_DISCOVERY_TIMEOUT = "6 seconds";

const printerAccessDisabledError = new PrinterToolUnavailableError({
  reason:
    "3D Printer agent access is disabled in T3 Code. Enable 3D Printers and Agent printer access in Settings -> 3D Printers; the change applies when the agent session next starts.",
});

const requirePrinterReadAccess = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const allowedCaller = scope.thread !== undefined || scope.client?.linked === true;
  if (!allowedCaller || !scope.capabilities.has("printer")) {
    return yield* printerAccessDisabledError;
  }
  return scope;
});

const requirePrinterThreadAccess = McpInvocationContext.requireThreadMcpCapability("printer").pipe(
  Effect.mapError(() => printerAccessDisabledError),
);

type LocalPrinterMatch =
  | { readonly kind: "found"; readonly printer: PrinterSnapshot }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly message: string };

function matchLocalPrinter(
  state: PrinterServiceState,
  localAllowed: boolean,
  threadId: ThreadId | undefined,
  requested: string | undefined,
): LocalPrinterMatch {
  if (!localAllowed || state.printers.length === 0) {
    return { kind: "none" };
  }
  const trimmed = requested?.trim();
  if (!trimmed) {
    if (threadId !== undefined) {
      const openLocalSessions = state.sessions.filter(
        (session) => session.threadId === threadId && session.proxyEnvironmentId === undefined,
      );
      if (openLocalSessions.length === 1) {
        const openPrinter = state.printers.find((p) => p.id === openLocalSessions[0]!.printerId);
        if (openPrinter) return { kind: "found", printer: openPrinter };
      }
    }
    if (state.printers.length === 1) {
      return { kind: "found", printer: state.printers[0]! };
    }
    const candidates = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
    return {
      kind: "ambiguous",
      message: `Multiple 3D printers are configured (${candidates}). Pass printerId to choose one.`,
    };
  }

  const exactId = state.printers.find((p) => p.id === trimmed);
  if (exactId) return { kind: "found", printer: exactId };

  const lower = trimmed.toLowerCase();
  const labelMatches = state.printers.filter(
    (p) =>
      p.id.toLowerCase() === lower ||
      p.label.toLowerCase() === lower ||
      p.hardware.name?.toLowerCase() === lower,
  );
  if (labelMatches.length === 1) return { kind: "found", printer: labelMatches[0]! };
  if (labelMatches.length > 1) {
    const candidates = labelMatches.map((p) => `${p.id} (${p.label})`).join(", ");
    return {
      kind: "ambiguous",
      message: `Printer selector "${trimmed}" is ambiguous (${candidates}). Pass the exact printerId.`,
    };
  }
  return { kind: "none" };
}

function cameraAgeSeconds(printer: PrinterSnapshot, nowMs: number): number | null {
  if (!printer.media.cameraUpdatedAt) return null;
  const parsed = Date.parse(printer.media.cameraUpdatedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

function capturedAgeSeconds(capturedAt: string, nowMs: number): number | null {
  const parsed = Date.parse(capturedAt);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

interface DiscoveredPeerPrinter {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly printer: (typeof PrinterListTool.successSchema.Type)["printers"][number];
}

interface PeerDiscoveryResult {
  readonly printers: ReadonlyArray<DiscoveredPeerPrinter>;
  readonly unreachablePeers: ReadonlyArray<string>;
}

interface PeerRuntime {
  readonly forwarding: Option.Option<PeerForwarding.PeerForwarding["Service"]>;
  readonly links: Option.Option<PeerLinks.PeerLinks["Service"]>;
}

const canDiscoverPeers = (
  scope: McpInvocationContext.McpInvocationScope,
  peers: PeerRuntime,
  peerAllowed: boolean,
): boolean =>
  peerAllowed &&
  scope.client?.linked !== true &&
  scope.linkedEnvironments !== false &&
  Option.isSome(peers.forwarding) &&
  Option.isSome(peers.links);

const discoverPeerPrinters = Effect.fn("McpPrinterHandlers.discoverPeerPrinters")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  peers: PeerRuntime,
  peerAllowed: boolean,
  refresh: boolean,
): Effect.fn.Return<PeerDiscoveryResult> {
  if (!canDiscoverPeers(scope, peers, peerAllowed)) {
    return { printers: [], unreachablePeers: [] };
  }
  const forwarding = Option.getOrUndefined(peers.forwarding);
  const links = Option.getOrUndefined(peers.links);
  if (!forwarding || !links) return { printers: [], unreachablePeers: [] };

  const enabled = yield* links.enabled.pipe(Effect.orElseSucceed(() => false));
  if (!enabled) return { printers: [], unreachablePeers: [] };

  const listed = yield* links.list.pipe(Effect.orElseSucceed(() => []));
  const now = yield* DateTime.now;
  const activeLinks = listed.filter(
    (link) =>
      link.environmentId !== scope.environmentId && DateTime.isGreaterThan(link.expiresAt, now),
  );
  if (activeLinks.length === 0) return { printers: [], unreachablePeers: [] };

  const unavailablePeers = activeLinks
    .filter((link) => link.status !== "reachable")
    .map((link) => link.label);
  const candidates = activeLinks.filter((link) => link.status === "reachable");
  if (candidates.length === 0) {
    return { printers: [], unreachablePeers: unavailablePeers };
  }

  const perPeer = yield* Effect.forEach(
    candidates,
    (link) =>
      forwarding
        .call(scope, PrinterListTool, link.environmentId, {
          environmentId: link.environmentId,
          refresh,
        })
        .pipe(
          Effect.timeoutOption(PEER_DISCOVERY_TIMEOUT),
          Effect.map(
            Option.match({
              onNone: () => ({
                printers: [] as ReadonlyArray<DiscoveredPeerPrinter>,
                unreachable: link.label,
              }),
              onSome: (result) => ({
                printers: result.enabled
                  ? result.printers.map((printer) => ({
                      environmentId: link.environmentId,
                      environmentLabel: link.label,
                      printer: {
                        ...printer,
                        environmentId: link.environmentId,
                        environmentLabel: link.label,
                      },
                    }))
                  : ([] as ReadonlyArray<DiscoveredPeerPrinter>),
                unreachable: null as string | null,
              }),
            }),
          ),
          Effect.orElseSucceed(() => ({
            printers: [] as ReadonlyArray<DiscoveredPeerPrinter>,
            unreachable: link.label,
          })),
        ),
    { concurrency: 4 },
  );
  return {
    printers: perPeer.flatMap((entry) => entry.printers),
    unreachablePeers: [
      ...unavailablePeers,
      ...perPeer
        .map((entry) => entry.unreachable)
        .filter((label): label is string => label !== null),
    ],
  };
});

const lookupPeerLabel = (
  peers: PeerRuntime,
  environmentId: EnvironmentId,
): Effect.Effect<string | undefined> => {
  if (Option.isNone(peers.links)) return Effect.succeed<string | undefined>(undefined);
  return peers.links.value.get(environmentId).pipe(
    Effect.map((found) => (Option.isSome(found) ? found.value.label : undefined)),
    Effect.orElseSucceed((): string | undefined => undefined),
  );
};

function matchDiscoveredPeerPrinter(
  discovery: PeerDiscoveryResult,
  requested: string | undefined,
): Effect.Effect<DiscoveredPeerPrinter, PrinterToolUnavailableError> {
  const { printers: discovered, unreachablePeers } = discovery;
  const unreachableSuffix =
    unreachablePeers.length > 0
      ? ` Unreachable linked environments: ${unreachablePeers.join(", ")}.`
      : "";
  if (discovered.length === 0) {
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason:
          unreachablePeers.length > 0
            ? `No 3D printers responded.${unreachableSuffix} Retry or specify an environmentId.`
            : "No 3D printers are configured locally or reachable on linked T3 Connect environments. Add one in Settings -> 3D Printers and enable Agent printer access on the host connected to the printer.",
      }),
    );
  }
  const trimmed = requested?.trim();
  if (!trimmed) {
    if (unreachablePeers.length > 0) {
      const candidates = discovered
        .map(
          (entry) => `${entry.printer.id} (${entry.printer.label} via ${entry.environmentLabel})`,
        )
        .join(", ");
      return Effect.fail(
        new PrinterToolUnavailableError({
          reason: `Cannot confirm a unique fleet printer because some linked environments did not answer (${unreachablePeers.join(", ")}). Responding printers: ${candidates}. Pass printerId and environmentId.`,
        }),
      );
    }
    if (discovered.length === 1) return Effect.succeed(discovered[0]!);
    const online = discovered.filter((entry) => entry.printer.online);
    if (online.length === 1) return Effect.succeed(online[0]!);
    const candidates = discovered
      .map((entry) => `${entry.printer.id} (${entry.printer.label} via ${entry.environmentLabel})`)
      .join(", ");
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: `Multiple 3D printers are available across T3 Connect (${candidates}). Pass printerId (and environmentId if needed).`,
      }),
    );
  }

  const exact = discovered.filter((entry) => entry.printer.id === trimmed);
  if (exact.length === 1) {
    if (unreachablePeers.length > 0) {
      return Effect.fail(
        new PrinterToolUnavailableError({
          reason: `Cannot confirm "${trimmed}" is unique across the fleet because some linked environments did not answer (${unreachablePeers.join(", ")}). Matching printer: ${exact[0]!.printer.id} via ${exact[0]!.environmentLabel} (${exact[0]!.environmentId}). Pass environmentId explicitly.`,
        }),
      );
    }
    return Effect.succeed(exact[0]!);
  }
  if (exact.length > 1) {
    const candidates = exact
      .map((entry) => `${entry.printer.id} via ${entry.environmentLabel} (${entry.environmentId})`)
      .join(", ");
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: `Printer "${trimmed}" exists on multiple environments (${candidates}). Pass environmentId to choose one.`,
      }),
    );
  }

  const lower = trimmed.toLowerCase();
  const fuzzy = discovered.filter(
    (entry) =>
      entry.printer.id.toLowerCase() === lower || entry.printer.label.toLowerCase() === lower,
  );
  if (fuzzy.length === 1) {
    if (unreachablePeers.length > 0) {
      return Effect.fail(
        new PrinterToolUnavailableError({
          reason: `Cannot confirm "${trimmed}" is unique across the fleet because some linked environments did not answer (${unreachablePeers.join(", ")}). Matching printer: ${fuzzy[0]!.printer.id} via ${fuzzy[0]!.environmentLabel} (${fuzzy[0]!.environmentId}). Pass environmentId explicitly.`,
        }),
      );
    }
    return Effect.succeed(fuzzy[0]!);
  }
  if (fuzzy.length > 1) {
    const candidates = fuzzy
      .map((entry) => `${entry.printer.id} (${entry.printer.label} via ${entry.environmentLabel})`)
      .join(", ");
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason: `Printer selector "${trimmed}" is ambiguous (${candidates}). Pass printerId and environmentId.`,
      }),
    );
  }

  const available = discovered
    .map((entry) => `${entry.printer.id} (${entry.printer.label} via ${entry.environmentLabel})`)
    .join(", ");
  return Effect.fail(
    new PrinterToolUnavailableError({
      reason: `Printer "${trimmed}" was not found. Available printers: ${available}.${unreachableSuffix}`,
    }),
  );
}

function findMatchingOpenProxySession(
  state: PrinterServiceState,
  threadId: ThreadId | undefined,
  requested: string | undefined,
  environmentId?: EnvironmentId,
) {
  if (threadId === undefined) return undefined;
  const openProxied = state.sessions.filter(
    (session) =>
      session.threadId === threadId &&
      session.proxyEnvironmentId !== undefined &&
      (environmentId === undefined || session.proxyEnvironmentId === environmentId),
  );
  if (openProxied.length === 0) return undefined;
  const trimmed = requested?.trim();
  if (!trimmed) {
    return openProxied.length === 1 ? openProxied[0] : undefined;
  }
  const lower = trimmed.toLowerCase();
  const matches = openProxied.filter(
    (session) =>
      session.printerId === trimmed ||
      session.printerId.toLowerCase() === lower ||
      session.printerLabel?.toLowerCase() === lower,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

interface PrinterInvocationPolicy {
  readonly localAllowed: boolean;
  readonly peerAllowed: boolean;
}

type ResolvedReadTarget =
  | { readonly kind: "local"; readonly printer: PrinterSnapshot }
  | {
      readonly kind: "remote";
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string | undefined;
      readonly printerId: PrinterId;
    };

const buildHandlers = Effect.gen(function* () {
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const peers: PeerRuntime = { forwarding, links };

  const resolvePrinterPolicy = Effect.fn("McpPrinterHandlers.resolvePrinterPolicy")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    state: PrinterServiceState | null,
  ): Effect.fn.Return<
    PrinterInvocationPolicy,
    never,
    ThreadManagementService.ThreadManagementService
  > {
    if (scope.client?.linked === true) {
      return {
        localAllowed: state !== null && state.enabled && state.agentAccessEnabled,
        peerAllowed: false,
      };
    }
    if (scope.thread === undefined) {
      return { localAllowed: false, peerAllowed: false };
    }
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const [settings, threadShell] = yield* Effect.all([
      settingsService.getSettings.pipe(Effect.orElseSucceed(() => null)),
      threads.getThreadShell(scope.thread.threadId).pipe(Effect.orElseSucceed(() => null)),
    ]);
    // Fail closed if settings or thread project policy cannot be resolved.
    if (settings === null || threadShell === null) {
      return { localAllowed: false, peerAllowed: false };
    }
    const effective = resolveProjectSettings(settings, threadShell.projectId).settings;
    const projectOverride =
      settings.projectSettingsOverrides[threadShell.projectId]?.enableAgentPrinterAccess;
    const localAllowed =
      settings.enablePrinterSupport &&
      effective.enableAgentPrinterAccess &&
      (state === null || state.enabled);
    const peerAllowed =
      scope.linkedEnvironments !== false &&
      settings.linkedEnvironmentsEnabled &&
      projectOverride !== false &&
      (!settings.enablePrinterSupport || effective.enableAgentPrinterAccess);
    return { localAllowed, peerAllowed };
  });

  const enforceRemotePrinterPolicy = Effect.fn("McpPrinterHandlers.enforceRemotePrinterPolicy")(
    function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const policy = yield* resolvePrinterPolicy(scope, null);
      if (!policy.peerAllowed) {
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message:
            "3D Printer agent access is disabled for this project or environment; cannot forward printer requests.",
        });
      }
    },
  );

  const resolveReadTarget = Effect.fn("McpPrinterHandlers.resolveReadTarget")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    state: PrinterServiceState,
    policy: PrinterInvocationPolicy,
    localOnly: boolean,
    requested: string | undefined,
  ): Effect.fn.Return<ResolvedReadTarget, PrinterToolUnavailableError> {
    if (scope.client?.linked === true && !policy.localAllowed) {
      return yield* printerAccessDisabledError;
    }

    const peerForwarding = Option.getOrUndefined(peers.forwarding);
    const peerDiscoveryAllowed =
      !localOnly &&
      canDiscoverPeers(scope, peers, policy.peerAllowed) &&
      peerForwarding !== undefined;
    const trimmed = requested?.trim();

    // When no selector is supplied, prefer the thread's sole open printer (local or proxied when not localOnly) before falling back.
    if (!trimmed && scope.thread !== undefined) {
      const openTargets: Array<ResolvedReadTarget> = [];
      for (const session of state.sessions) {
        if (session.threadId !== scope.thread.threadId) continue;
        if (session.proxyEnvironmentId === undefined) {
          if (!policy.localAllowed) continue;
          const localPrinter = state.printers.find((p) => p.id === session.printerId);
          if (localPrinter) {
            openTargets.push({ kind: "local", printer: localPrinter });
          }
        } else if (peerDiscoveryAllowed) {
          const label = yield* lookupPeerLabel(peers, session.proxyEnvironmentId);
          openTargets.push({
            kind: "remote",
            environmentId: session.proxyEnvironmentId,
            environmentLabel: label,
            printerId: session.printerId,
          });
        }
      }
      if (openTargets.length === 1) {
        return openTargets[0]!;
      }
      if (openTargets.length > 1) {
        const candidates = openTargets
          .map((target) =>
            target.kind === "local"
              ? `${target.printer.id} (${target.printer.label})`
              : `${target.printerId} via ${target.environmentLabel ?? target.environmentId}`,
          )
          .join(", ");
        return yield* new PrinterToolUnavailableError({
          reason: `Multiple 3D printers are open in this thread (${candidates}). Pass printerId (and environmentId if needed).`,
        });
      }
    }

    const localMatch = matchLocalPrinter(
      state,
      policy.localAllowed,
      scope.thread?.threadId,
      requested,
    );
    if (localMatch.kind === "ambiguous") {
      return yield* new PrinterToolUnavailableError({ reason: localMatch.message });
    }
    if (localMatch.kind === "found") {
      return { kind: "local", printer: localMatch.printer };
    }

    if (peerDiscoveryAllowed) {
      const openProxy = findMatchingOpenProxySession(state, scope.thread?.threadId, requested);
      if (openProxy?.proxyEnvironmentId !== undefined) {
        const label = yield* lookupPeerLabel(peers, openProxy.proxyEnvironmentId);
        return {
          kind: "remote",
          environmentId: openProxy.proxyEnvironmentId,
          environmentLabel: label,
          printerId: openProxy.printerId,
        };
      }

      const discovery = yield* discoverPeerPrinters(scope, peers, policy.peerAllowed, false);
      const chosen = yield* matchDiscoveredPeerPrinter(discovery, requested);
      return {
        kind: "remote",
        environmentId: chosen.environmentId,
        environmentLabel: chosen.environmentLabel,
        printerId: chosen.printer.id,
      };
    }

    const available = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
    return yield* new PrinterToolUnavailableError({
      reason: !policy.localAllowed
        ? "3D Printer support is disabled in Settings -> 3D Printers."
        : state.printers.length === 0
          ? "No 3D printers are configured on this environment. Add one in Settings -> 3D Printers."
          : `Printer "${requested ?? ""}" was not found. Available printers: ${available}.`,
    });
  });

  const resolveStatusLocally = Effect.fn("McpPrinterHandlers.resolveStatusLocally")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    printers: PrinterService.PrinterService["Service"],
    target: PrinterSnapshot,
  ) {
    const refreshed = yield* printers.list({ printerId: target.id, refresh: true });
    const updated = refreshed.printers.find((p) => p.id === target.id);
    if (!updated) {
      return yield* new PrinterToolUnavailableError({
        reason: `Printer "${target.id}" is no longer configured.`,
      });
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const age = cameraAgeSeconds(updated, nowMs);
    const note = updated.stale
      ? (updated.staleReason ??
        "Telemetry is stale or printer is offline; do not treat values as live.")
      : "Telemetry is live. ETA values are printer estimates; recommend pause or stop to the user rather than modifying hardware directly.";
    return {
      printer: updated,
      cameraAgeSeconds: age,
      environmentId: scope.environmentId,
      note,
    };
  });

  const resolveSnapshotLocally = Effect.fn("McpPrinterHandlers.resolveSnapshotLocally")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    printers: PrinterService.PrinterService["Service"],
    target: PrinterSnapshot,
  ) {
    if (!target.media.hasCamera) {
      return yield* new PrinterToolUnavailableError({
        reason: `Printer "${target.label}" does not expose a live camera feed.`,
      });
    }
    const asset = yield* printers.fetchMedia(target.id, "camera");
    if (asset.bytes.byteLength > MAX_PRINTER_SNAPSHOT_BYTES) {
      return yield* new PrinterToolUnavailableError({
        reason: `Camera snapshot (${(asset.bytes.byteLength / (1024 * 1024)).toFixed(1)} MB) exceeded the ${Math.round(MAX_PRINTER_SNAPSHOT_BYTES / (1024 * 1024))} MB transfer limit.`,
      });
    }
    const dims = imageDimensions(asset.bytes, asset.contentType);
    if (dims.width <= 0 || dims.height <= 0) {
      return yield* new PrinterToolUnavailableError({
        reason: `Camera snapshot from "${target.label}" was truncated or not a valid JPEG/PNG image.`,
      });
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const age = capturedAgeSeconds(asset.capturedAt, nowMs);
    return {
      printerId: target.id,
      printerLabel: target.label,
      online: asset.online,
      stale: asset.stale,
      capturedAt: asset.capturedAt,
      cameraAgeSeconds: age,
      environmentId: scope.environmentId,
      screenshot: {
        mimeType: asset.contentType,
        data: Buffer.from(asset.bytes).toString("base64"),
        width: dims.width,
        height: dims.height,
      },
    };
  });

  const handlers = {
    printer_list: McpToolAccess.afterForwarding(
      McpToolAccess.readsWithCapability(
        "printer",
        (input) =>
          Effect.gen(function* () {
            const scope = yield* requirePrinterReadAccess;
            const localOnly = yield* McpToolAccess.ExplicitLocalEnvironment;
            const printers = yield* PrinterService.PrinterService;
            const currentState = yield* printers.state;
            const policy = yield* resolvePrinterPolicy(scope, currentState);
            const state = policy.localAllowed
              ? yield* printers.list({ refresh: input.refresh ?? true })
              : currentState;
            const threadId = scope.thread?.threadId;
            const openLocalIds = new Set(
              threadId === undefined
                ? []
                : state.sessions
                    .filter(
                      (session) =>
                        session.threadId === threadId && session.proxyEnvironmentId === undefined,
                    )
                    .map((session) => session.printerId),
            );
            const openProxiedKeys = new Set(
              threadId === undefined
                ? []
                : state.sessions
                    .filter(
                      (session) =>
                        session.threadId === threadId && session.proxyEnvironmentId !== undefined,
                    )
                    .map((session) => `${session.proxyEnvironmentId}\u0000${session.printerId}`),
            );
            const localEntries = policy.localAllowed
              ? state.printers.map((printer) => ({
                  id: printer.id,
                  label: printer.label,
                  kind: printer.kind,
                  model: printer.hardware.model,
                  online: printer.online,
                  stale: printer.stale,
                  status: printer.job.status,
                  stageLabel: printer.job.stageLabel,
                  fileName: printer.job.fileName,
                  progressPercent: printer.job.progressPercent,
                  hasCamera: printer.media.hasCamera,
                  openInThread: openLocalIds.has(printer.id),
                  environmentId: scope.environmentId,
                }))
              : [];
            const peerDiscovery = localOnly
              ? { printers: [], unreachablePeers: [] }
              : yield* discoverPeerPrinters(
                  scope,
                  peers,
                  policy.peerAllowed,
                  input.refresh ?? false,
                );
            const peerEntries = peerDiscovery.printers.map(
              ({ environmentId, environmentLabel, printer }) => ({
                ...printer,
                environmentId,
                environmentLabel,
                openInThread: openProxiedKeys.has(`${environmentId}\u0000${printer.id}`),
              }),
            );
            return {
              enabled: policy.localAllowed || peerEntries.length > 0,
              printers: [...localEntries, ...peerEntries],
            };
          }),
        enforceRemotePrinterPolicy,
      ),
      (_input, targetEnvId, result) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const printers = yield* PrinterService.PrinterService;
          const state = yield* printers.state;
          const threadId = scope.thread?.threadId;
          const openProxiedIds = new Set(
            threadId === undefined
              ? []
              : state.sessions
                  .filter(
                    (session) =>
                      session.threadId === threadId && session.proxyEnvironmentId === targetEnvId,
                  )
                  .map((session) => session.printerId),
          );
          const label = yield* lookupPeerLabel(peers, targetEnvId);
          return {
            ...result,
            printers: result.printers.map((printer) => ({
              ...printer,
              environmentId: targetEnvId,
              ...(label ? { environmentLabel: label } : {}),
              openInThread: openProxiedIds.has(printer.id),
            })),
          };
        }),
    ),

    printer_open: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterThreadAccess;
        const printers = yield* PrinterService.PrinterService;
        const state = yield* printers.list({ refresh: false });
        const policy = yield* resolvePrinterPolicy(scope, state);
        const remoteEnvId = PeerForwarding.remoteTarget(scope, input.environmentId);
        const localOnly = input.environmentId !== undefined && remoteEnvId === undefined;

        if (remoteEnvId !== undefined) {
          if (scope.linkedEnvironments === false) {
            return yield* PeerForwarding.linkedEnvironmentsOff;
          }
          if (!policy.peerAllowed) {
            return yield* printerAccessDisabledError;
          }
          const peerForwarding = Option.getOrUndefined(peers.forwarding);
          if (!peerForwarding) {
            return yield* new PrinterToolUnavailableError({
              reason: "Linked environments are not available on this server.",
            });
          }
          const remoteStatus = yield* peerForwarding.call(scope, PrinterStatusTool, remoteEnvId, {
            environmentId: remoteEnvId,
            ...(input.printerId ? { printerId: input.printerId } : {}),
          });
          const label = yield* lookupPeerLabel(peers, remoteEnvId);
          yield* printers.open({
            threadId: scope.thread.threadId,
            printerId: remoteStatus.printer.id,
            proxyEnvironmentId: remoteEnvId,
            printerLabel: remoteStatus.printer.label,
          });
          return {
            printer: remoteStatus.printer,
            environmentId: remoteEnvId,
            ...(label ? { environmentLabel: label } : {}),
            note: `Opened ${remoteStatus.printer.label} (routed via ${label ?? remoteEnvId} over T3 Connect) in the Printer panel. Hardware write controls stay in the panel UI for human confirmation.`,
          };
        }

        const localMatch = matchLocalPrinter(
          state,
          policy.localAllowed,
          scope.thread.threadId,
          input.printerId,
        );
        if (localMatch.kind === "ambiguous") {
          return yield* new PrinterToolUnavailableError({ reason: localMatch.message });
        }
        if (localMatch.kind === "found") {
          yield* printers.open({
            threadId: scope.thread.threadId,
            printerId: localMatch.printer.id,
          });
          const refreshedState = yield* printers.state;
          const updated = refreshedState.printers.find((p) => p.id === localMatch.printer.id);
          if (!updated) {
            return yield* new PrinterToolUnavailableError({
              reason: `Printer "${localMatch.printer.id}" is no longer configured.`,
            });
          }
          return {
            printer: updated,
            environmentId: scope.environmentId,
            note: `Opened ${updated.label} in the Printer panel. Hardware write controls stay in the panel UI for human confirmation.`,
          };
        }

        const peerForwarding = Option.getOrUndefined(peers.forwarding);
        if (localOnly || !canDiscoverPeers(scope, peers, policy.peerAllowed) || !peerForwarding) {
          return yield* new PrinterToolUnavailableError({
            reason: policy.localAllowed
              ? state.printers.length === 0
                ? "No 3D printers are configured on this environment. Add one in Settings -> 3D Printers."
                : `Printer "${input.printerId ?? ""}" was not found.`
              : "3D Printer support is disabled in Settings -> 3D Printers.",
          });
        }

        const discovery = yield* discoverPeerPrinters(scope, peers, policy.peerAllowed, false);
        const chosen = yield* matchDiscoveredPeerPrinter(discovery, input.printerId);
        const remoteStatus = yield* peerForwarding.call(
          scope,
          PrinterStatusTool,
          chosen.environmentId,
          {
            environmentId: chosen.environmentId,
            printerId: chosen.printer.id,
          },
        );
        yield* printers.open({
          threadId: scope.thread.threadId,
          printerId: remoteStatus.printer.id,
          proxyEnvironmentId: chosen.environmentId,
          printerLabel: remoteStatus.printer.label,
        });
        return {
          printer: remoteStatus.printer,
          environmentId: chosen.environmentId,
          environmentLabel: chosen.environmentLabel,
          note: `Opened ${remoteStatus.printer.label} (routed via ${chosen.environmentLabel} over T3 Connect) in the Printer panel. Hardware write controls stay in the panel UI for human confirmation.`,
        };
      }),
    ),

    printer_status: McpToolAccess.readsWithCapability(
      "printer",
      (input) =>
        Effect.gen(function* () {
          const scope = yield* requirePrinterReadAccess;
          const localOnly = yield* McpToolAccess.ExplicitLocalEnvironment;
          const printers = yield* PrinterService.PrinterService;
          const state = yield* printers.list({ refresh: false });
          const policy = yield* resolvePrinterPolicy(scope, state);
          const target = yield* resolveReadTarget(scope, state, policy, localOnly, input.printerId);

          if (target.kind === "local") {
            return yield* resolveStatusLocally(scope, printers, target.printer);
          }

          const peerForwarding = Option.getOrUndefined(peers.forwarding);
          if (!peerForwarding) {
            return yield* new PrinterToolUnavailableError({
              reason: "Linked environments are not available on this server.",
            });
          }
          const forwarded = yield* peerForwarding.call(
            scope,
            PrinterStatusTool,
            target.environmentId,
            {
              environmentId: target.environmentId,
              printerId: target.printerId,
            },
          );
          return {
            ...forwarded,
            environmentId: target.environmentId,
            ...(target.environmentLabel ? { environmentLabel: target.environmentLabel } : {}),
          };
        }),
      enforceRemotePrinterPolicy,
    ),

    printer_camera_snapshot: McpToolAccess.readsWithCapability(
      "printer",
      (input) =>
        Effect.gen(function* () {
          const scope = yield* requirePrinterReadAccess;
          const localOnly = yield* McpToolAccess.ExplicitLocalEnvironment;
          const printers = yield* PrinterService.PrinterService;
          const state = yield* printers.list({ refresh: false });
          const policy = yield* resolvePrinterPolicy(scope, state);
          const target = yield* resolveReadTarget(scope, state, policy, localOnly, input.printerId);

          if (target.kind === "local") {
            return yield* resolveSnapshotLocally(scope, printers, target.printer);
          }

          const peerForwarding = Option.getOrUndefined(peers.forwarding);
          if (!peerForwarding) {
            return yield* new PrinterToolUnavailableError({
              reason: "Linked environments are not available on this server.",
            });
          }
          const forwarded = yield* peerForwarding.call(
            scope,
            PrinterCameraSnapshotTool,
            target.environmentId,
            {
              environmentId: target.environmentId,
              printerId: target.printerId,
            },
          );
          return {
            ...forwarded,
            environmentId: target.environmentId,
            ...(target.environmentLabel ? { environmentLabel: target.environmentLabel } : {}),
          };
        }),
      enforceRemotePrinterPolicy,
    ),

    printer_close: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterThreadAccess;
        const printers = yield* PrinterService.PrinterService;
        const state = yield* printers.state;

        if (input.environmentId !== undefined) {
          const remoteEnvId = PeerForwarding.remoteTarget(scope, input.environmentId);
          if (remoteEnvId !== undefined) {
            const openProxy = input.printerId
              ? findMatchingOpenProxySession(
                  state,
                  scope.thread.threadId,
                  input.printerId,
                  remoteEnvId,
                )
              : undefined;
            yield* printers.close({
              threadId: scope.thread.threadId,
              ...(input.printerId
                ? { printerId: (openProxy?.printerId ?? input.printerId.trim()) as PrinterId }
                : {}),
              proxyEnvironmentId: remoteEnvId,
            });
            return {};
          }
          const policy = yield* resolvePrinterPolicy(scope, state);
          const localMatch = input.printerId
            ? matchLocalPrinter(state, policy.localAllowed, scope.thread.threadId, input.printerId)
            : { kind: "none" as const };
          yield* printers.close({
            threadId: scope.thread.threadId,
            ...(input.printerId
              ? {
                  printerId:
                    localMatch.kind === "found"
                      ? localMatch.printer.id
                      : (input.printerId.trim() as PrinterId),
                }
              : {}),
            proxyEnvironmentId: null,
          });
          return {};
        }

        if (input.printerId) {
          const policy = yield* resolvePrinterPolicy(scope, state);
          const localMatch = matchLocalPrinter(
            state,
            policy.localAllowed,
            scope.thread.threadId,
            input.printerId,
          );
          const hasOpenLocal =
            localMatch.kind === "found" &&
            state.sessions.some(
              (session) =>
                session.threadId === scope.thread.threadId &&
                session.proxyEnvironmentId === undefined &&
                session.printerId === localMatch.printer.id,
            );
          if (hasOpenLocal) {
            yield* printers.close({
              threadId: scope.thread.threadId,
              printerId: localMatch.printer.id,
              proxyEnvironmentId: null,
            });
          } else {
            const openProxy = findMatchingOpenProxySession(
              state,
              scope.thread.threadId,
              input.printerId,
            );
            if (openProxy?.proxyEnvironmentId !== undefined) {
              yield* printers.close({
                threadId: scope.thread.threadId,
                printerId: openProxy.printerId,
                proxyEnvironmentId: openProxy.proxyEnvironmentId,
              });
            } else {
              yield* printers.close({
                threadId: scope.thread.threadId,
                printerId: input.printerId.trim() as PrinterId,
              });
            }
          }
        } else {
          yield* printers.close({ threadId: scope.thread.threadId });
        }
        return {};
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PrinterToolkit.tools>;

  return handlers;
});

export const layerStandard = McpToolAccess.toLayer(
  PrinterStandardToolkit,
  Effect.map(buildHandlers, ({ printer_camera_snapshot: _omit, ...standard }) => standard),
);

export const layerSnapshot = McpToolAccess.toLayer(
  PrinterSnapshotToolkit,
  Effect.map(buildHandlers, ({ printer_camera_snapshot }) => ({ printer_camera_snapshot })),
);
