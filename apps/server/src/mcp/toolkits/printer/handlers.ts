import {
  type EnvironmentId,
  type PrinterId,
  type PrinterServiceState,
  type PrinterSnapshot,
  PrinterToolUnavailableError,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { imageDimensions } from "../../../printer/PrinterAdapter.ts";
import * as PrinterService from "../../../printer/PrinterService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
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

function localPrinterAccessAllowed(state: PrinterServiceState): boolean {
  return state.enabled && state.agentAccessEnabled;
}

type LocalPrinterMatch =
  | { readonly kind: "found"; readonly printer: PrinterSnapshot }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly message: string };

function matchLocalPrinter(
  state: PrinterServiceState,
  threadId: ThreadId | undefined,
  requested: string | undefined,
): LocalPrinterMatch {
  if (!localPrinterAccessAllowed(state) || state.printers.length === 0) {
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

interface DiscoveredPeerPrinter {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly printer: (typeof PrinterListTool.successSchema.Type)["printers"][number];
}

interface PeerRuntime {
  readonly forwarding: Option.Option<PeerForwarding.PeerForwarding["Service"]>;
  readonly links: Option.Option<PeerLinks.PeerLinks["Service"]>;
}

const canDiscoverPeers = (
  scope: McpInvocationContext.McpInvocationScope,
  peers: PeerRuntime,
): boolean =>
  scope.client?.linked !== true &&
  scope.linkedEnvironments !== false &&
  Option.isSome(peers.forwarding) &&
  Option.isSome(peers.links);

const discoverPeerPrinters = Effect.fn("McpPrinterHandlers.discoverPeerPrinters")(function* (
  scope: McpInvocationContext.McpInvocationScope,
  peers: PeerRuntime,
  refresh: boolean,
): Effect.fn.Return<ReadonlyArray<DiscoveredPeerPrinter>> {
  if (!canDiscoverPeers(scope, peers)) return [];
  const forwarding = Option.getOrUndefined(peers.forwarding);
  const links = Option.getOrUndefined(peers.links);
  if (!forwarding || !links) return [];

  const enabled = yield* links.enabled.pipe(Effect.orElseSucceed(() => false));
  if (!enabled) return [];

  const listed = yield* links.list.pipe(Effect.orElseSucceed(() => []));
  const now = yield* DateTime.now;
  const candidates = listed.filter(
    (link) =>
      link.environmentId !== scope.environmentId &&
      link.status === "reachable" &&
      DateTime.isGreaterThan(link.expiresAt, now),
  );
  if (candidates.length === 0) return [];

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
              onNone: () => [] as ReadonlyArray<DiscoveredPeerPrinter>,
              onSome: (result) =>
                result.enabled
                  ? result.printers.map((printer) => ({
                      environmentId: link.environmentId,
                      environmentLabel: link.label,
                      printer: {
                        ...printer,
                        environmentId: link.environmentId,
                        environmentLabel: link.label,
                      },
                    }))
                  : [],
            }),
          ),
          Effect.orElseSucceed(() => [] as ReadonlyArray<DiscoveredPeerPrinter>),
        ),
    { concurrency: 4 },
  );
  return perPeer.flat();
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
  discovered: ReadonlyArray<DiscoveredPeerPrinter>,
  requested: string | undefined,
): Effect.Effect<DiscoveredPeerPrinter, PrinterToolUnavailableError> {
  if (discovered.length === 0) {
    return Effect.fail(
      new PrinterToolUnavailableError({
        reason:
          "No 3D printers are configured locally or reachable on linked T3 Connect environments. Add one in Settings -> 3D Printers and enable Agent printer access on the host connected to the printer.",
      }),
    );
  }
  const trimmed = requested?.trim();
  if (!trimmed) {
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
  if (exact.length === 1) return Effect.succeed(exact[0]!);
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
  if (fuzzy.length === 1) return Effect.succeed(fuzzy[0]!);
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
      reason: `Printer "${trimmed}" was not found. Available printers: ${available}.`,
    }),
  );
}

function findMatchingOpenProxySession(
  state: PrinterServiceState,
  threadId: ThreadId | undefined,
  requested: string | undefined,
) {
  if (threadId === undefined) return undefined;
  const openProxied = state.sessions.filter(
    (session) => session.threadId === threadId && session.proxyEnvironmentId !== undefined,
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

const buildHandlers = Effect.gen(function* () {
  const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peers: PeerRuntime = { forwarding, links };

  const resolveStatusLocally = Effect.fn("McpPrinterHandlers.resolveStatusLocally")(function* (
    scope: McpInvocationContext.McpInvocationScope,
    printers: PrinterService.PrinterService["Service"],
    target: PrinterSnapshot,
  ) {
    const refreshed = yield* printers.list({ printerId: target.id, refresh: true });
    const updated = refreshed.printers.find((p) => p.id === target.id) ?? target;
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
    const dims = imageDimensions(asset.bytes, asset.contentType);
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    const latestState = yield* printers.state;
    const updatedTarget = latestState.printers.find((p) => p.id === target.id) ?? target;
    const parsedCapturedMs = Date.parse(asset.capturedAt);
    const age =
      cameraAgeSeconds(updatedTarget, nowMs) ??
      (Number.isFinite(parsedCapturedMs)
        ? Math.max(0, Math.round((nowMs - parsedCapturedMs) / 1000))
        : null);
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
    printer_list: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterReadAccess;
        const printers = yield* PrinterService.PrinterService;
        const currentState = yield* printers.state;
        const localAllowed = localPrinterAccessAllowed(currentState);
        const state = localAllowed
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
        const localEntries = localAllowed
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
        const peerEntries = (yield* discoverPeerPrinters(scope, peers, input.refresh ?? false)).map(
          ({ environmentId, environmentLabel, printer }) => ({
            ...printer,
            environmentId,
            environmentLabel,
            openInThread: openProxiedKeys.has(`${environmentId}\u0000${printer.id}`),
          }),
        );
        return {
          enabled: localAllowed || peerEntries.length > 0,
          printers: [...localEntries, ...peerEntries],
        };
      }),
    ),

    printer_open: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterThreadAccess;
        const printers = yield* PrinterService.PrinterService;
        const state = yield* printers.list({ refresh: false });
        const remoteEnvId = PeerForwarding.remoteTarget(scope, input.environmentId);

        if (remoteEnvId !== undefined) {
          if (scope.linkedEnvironments === false) {
            return yield* PeerForwarding.linkedEnvironmentsOff;
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

        const localMatch = matchLocalPrinter(state, scope.thread.threadId, input.printerId);
        if (localMatch.kind === "ambiguous") {
          return yield* new PrinterToolUnavailableError({ reason: localMatch.message });
        }
        if (localMatch.kind === "found") {
          yield* printers.open({
            threadId: scope.thread.threadId,
            printerId: localMatch.printer.id,
          });
          const refreshedState = yield* printers.state;
          const updated =
            refreshedState.printers.find((p) => p.id === localMatch.printer.id) ??
            localMatch.printer;
          return {
            printer: updated,
            environmentId: scope.environmentId,
            note: `Opened ${updated.label} in the Printer panel. Hardware write controls stay in the panel UI for human confirmation.`,
          };
        }

        const peerForwarding = Option.getOrUndefined(peers.forwarding);
        if (!canDiscoverPeers(scope, peers) || !peerForwarding) {
          return yield* new PrinterToolUnavailableError({
            reason: state.enabled
              ? state.printers.length === 0
                ? "No 3D printers are configured. Add one in Settings -> 3D Printers."
                : `Printer "${input.printerId ?? ""}" was not found.`
              : "3D Printer support is disabled in Settings -> 3D Printers.",
          });
        }

        const discovered = yield* discoverPeerPrinters(scope, peers, false);
        const chosen = yield* matchDiscoveredPeerPrinter(discovered, input.printerId);
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

    printer_status: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterReadAccess;
        const printers = yield* PrinterService.PrinterService;
        const state = yield* printers.list({ refresh: false });

        if (scope.client?.linked === true) {
          if (!localPrinterAccessAllowed(state)) {
            return yield* printerAccessDisabledError;
          }
        }

        const localMatch = matchLocalPrinter(state, scope.thread?.threadId, input.printerId);
        if (localMatch.kind === "ambiguous") {
          return yield* new PrinterToolUnavailableError({ reason: localMatch.message });
        }
        if (localMatch.kind === "found") {
          return yield* resolveStatusLocally(scope, printers, localMatch.printer);
        }

        const peerForwarding = Option.getOrUndefined(peers.forwarding);
        if (canDiscoverPeers(scope, peers) && peerForwarding) {
          const openProxy = findMatchingOpenProxySession(
            state,
            scope.thread?.threadId,
            input.printerId,
          );
          if (openProxy?.proxyEnvironmentId !== undefined) {
            const label = yield* lookupPeerLabel(peers, openProxy.proxyEnvironmentId);
            const forwarded = yield* peerForwarding.call(
              scope,
              PrinterStatusTool,
              openProxy.proxyEnvironmentId,
              {
                environmentId: openProxy.proxyEnvironmentId,
                printerId: openProxy.printerId,
              },
            );
            return {
              ...forwarded,
              environmentId: openProxy.proxyEnvironmentId,
              ...(label ? { environmentLabel: label } : {}),
            };
          }

          const discovered = yield* discoverPeerPrinters(scope, peers, false);
          const chosen = yield* matchDiscoveredPeerPrinter(discovered, input.printerId);
          const forwarded = yield* peerForwarding.call(
            scope,
            PrinterStatusTool,
            chosen.environmentId,
            {
              environmentId: chosen.environmentId,
              printerId: chosen.printer.id,
            },
          );
          return {
            ...forwarded,
            environmentId: chosen.environmentId,
            environmentLabel: chosen.environmentLabel,
          };
        }

        const available = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
        return yield* new PrinterToolUnavailableError({
          reason: !localPrinterAccessAllowed(state)
            ? "3D Printer support is disabled in Settings -> 3D Printers."
            : state.printers.length === 0
              ? "No 3D printers are configured. Add one in Settings -> 3D Printers."
              : `Printer "${input.printerId ?? ""}" was not found. Available printers: ${available}.`,
        });
      }),
    ),

    printer_camera_snapshot: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterReadAccess;
        const printers = yield* PrinterService.PrinterService;
        const state = yield* printers.list({ refresh: false });

        if (scope.client?.linked === true) {
          if (!localPrinterAccessAllowed(state)) {
            return yield* printerAccessDisabledError;
          }
        }

        const localMatch = matchLocalPrinter(state, scope.thread?.threadId, input.printerId);
        if (localMatch.kind === "ambiguous") {
          return yield* new PrinterToolUnavailableError({ reason: localMatch.message });
        }
        if (localMatch.kind === "found") {
          return yield* resolveSnapshotLocally(scope, printers, localMatch.printer);
        }

        const peerForwarding = Option.getOrUndefined(peers.forwarding);
        if (canDiscoverPeers(scope, peers) && peerForwarding) {
          const openProxy = findMatchingOpenProxySession(
            state,
            scope.thread?.threadId,
            input.printerId,
          );
          if (openProxy?.proxyEnvironmentId !== undefined) {
            const label = yield* lookupPeerLabel(peers, openProxy.proxyEnvironmentId);
            const forwarded = yield* peerForwarding.call(
              scope,
              PrinterCameraSnapshotTool,
              openProxy.proxyEnvironmentId,
              {
                environmentId: openProxy.proxyEnvironmentId,
                printerId: openProxy.printerId,
              },
            );
            return {
              ...forwarded,
              environmentId: openProxy.proxyEnvironmentId,
              ...(label ? { environmentLabel: label } : {}),
            };
          }

          const discovered = yield* discoverPeerPrinters(scope, peers, false);
          const chosen = yield* matchDiscoveredPeerPrinter(discovered, input.printerId);
          const forwarded = yield* peerForwarding.call(
            scope,
            PrinterCameraSnapshotTool,
            chosen.environmentId,
            {
              environmentId: chosen.environmentId,
              printerId: chosen.printer.id,
            },
          );
          return {
            ...forwarded,
            environmentId: chosen.environmentId,
            environmentLabel: chosen.environmentLabel,
          };
        }

        const available = state.printers.map((p) => `${p.id} (${p.label})`).join(", ");
        return yield* new PrinterToolUnavailableError({
          reason: !localPrinterAccessAllowed(state)
            ? "3D Printer support is disabled in Settings -> 3D Printers."
            : state.printers.length === 0
              ? "No 3D printers are configured. Add one in Settings -> 3D Printers."
              : `Printer "${input.printerId ?? ""}" was not found. Available printers: ${available}.`,
        });
      }),
    ),

    printer_close: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const scope = yield* requirePrinterThreadAccess;
        const printers = yield* PrinterService.PrinterService;
        if (input.printerId) {
          const state = yield* printers.state;
          const localMatch = matchLocalPrinter(state, scope.thread.threadId, input.printerId);
          if (localMatch.kind === "found") {
            yield* printers.close({
              threadId: scope.thread.threadId,
              printerId: localMatch.printer.id,
            });
          } else {
            const openProxy = findMatchingOpenProxySession(
              state,
              scope.thread.threadId,
              input.printerId,
            );
            yield* printers.close({
              threadId: scope.thread.threadId,
              printerId: (openProxy?.printerId ?? input.printerId.trim()) as PrinterId,
            });
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
