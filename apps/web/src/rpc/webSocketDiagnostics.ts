import type { KnownEnvironment } from "@t3tools/client-runtime";
import { scopedThreadKey } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, TerminalEvent, ThreadId } from "@t3tools/contracts";

import {
  getPrimaryKnownEnvironment,
  readPrimaryEnvironmentDescriptor,
} from "../environments/primary";
import {
  listEnvironmentConnections,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { getResumeDiagnosticsEntries } from "../environments/runtime/resumeDiagnostics";
import { downloadPlanAsTextFile } from "../proposedPlan";
import { getThreadFromEnvironmentState } from "../threadDerivation";
import { selectEnvironmentState, useStore } from "../store";
import { getTerminalDiagnosticsSnapshot } from "../lib/terminalDiagnosticsState";
import {
  getPendingRpcAckRequests,
  getSlowRpcAckRequests,
  type SlowRpcAckRequest,
} from "./requestLatencyState";
import { getServerConfig, getServerConfigUpdatedNotification } from "./serverState";
import { getWsConnectionStatus, getWsConnectionUiState } from "./wsConnectionState";
import {
  selectTerminalEventEntries,
  selectThreadTerminalState,
  useTerminalStateStore,
} from "../terminalStateStore";

const MAX_RECENT_TERMINAL_EVENTS = 20;
const MAX_RESUME_DIAGNOSTIC_ENTRIES = 500;
const REDACTED = "<redacted>";

export interface WebSocketDiagnosticsContext {
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly activeThreadId: ThreadId;
  readonly activeThreadTitle: string;
  readonly activeProjectName: string | undefined;
  readonly diffOpen: boolean;
  readonly fileExplorerAvailable: boolean;
  readonly fileExplorerOpen: boolean;
  readonly gitCwd: string | null;
  readonly openInCwd: string | null;
  readonly sourceControlOpen: boolean;
  readonly terminalAvailable: boolean;
  readonly terminalOpen: boolean;
}

export interface WebSocketDiagnosticsExportResult {
  readonly filename: string;
}

type JsonObject = Record<string, unknown>;

function isoNow(): string {
  return new Date().toISOString();
}

function msSinceIso(isoDate: string | null, nowMs: number): number | null {
  if (!isoDate) {
    return null;
  }
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.max(0, Math.round(nowMs - timestamp));
}

function msUntilIso(isoDate: string | null, nowMs: number): number | null {
  if (!isoDate) {
    return null;
  }
  const timestamp = new Date(isoDate).getTime();
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return Math.round(timestamp - nowMs);
}

function bytesForText(text: string): number {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }
  return text.length;
}

function redactUrl(rawUrl: string | null | undefined): string | null {
  const normalized = rawUrl?.trim();
  if (!normalized) {
    return null;
  }

  try {
    const fallbackOrigin =
      typeof window !== "undefined" ? window.location.origin : "http://salchi.local";
    const isAbsolute = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(normalized);
    const parsed = new URL(normalized, fallbackOrigin);
    parsed.username = parsed.username ? REDACTED : "";
    parsed.password = parsed.password ? REDACTED : "";

    const queryParamKeys = new Set(parsed.searchParams.keys());
    for (const key of queryParamKeys) {
      parsed.searchParams.set(key, REDACTED);
    }
    if (parsed.hash) {
      parsed.hash = `#${REDACTED}`;
    }

    if (!isAbsolute && parsed.origin === fallbackOrigin) {
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.toString();
  } catch {
    return normalized.replace(
      /([?&#][^=]*?(?:token|secret|credential|password)[^=]*=)[^&#]*/gi,
      ["$1", REDACTED].join(""),
    );
  }
}

function redactRecordValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactRecordValues(item));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      if (/token|secret|credential|password|authorization|cookie/i.test(key)) {
        return [key, REDACTED];
      }
      if (/url$/i.test(key) && typeof entry === "string") {
        return [key, redactUrl(entry)];
      }
      return [key, redactRecordValues(entry)];
    }),
  );
}

function jsonBlock(value: unknown): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n");
}

function formatMs(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  if (Math.abs(value) < 1_000) {
    return `${value}ms`;
  }
  return `${Math.round(value / 100) / 10}s`;
}

function summarizeKnownEnvironment(
  environment: KnownEnvironment | null | undefined,
): JsonObject | null {
  if (!environment) {
    return null;
  }
  return {
    environmentId: environment.environmentId ?? null,
    id: environment.id,
    label: environment.label,
    source: environment.source,
    target: {
      httpBaseUrl: redactUrl(environment.target.httpBaseUrl),
      wsBaseUrl: redactUrl(environment.target.wsBaseUrl),
    },
  };
}

function readPrimaryDescriptorForDiagnostics() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return readPrimaryEnvironmentDescriptor();
  } catch {
    return null;
  }
}

function readPrimaryKnownEnvironmentForDiagnostics() {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return getPrimaryKnownEnvironment();
  } catch {
    return null;
  }
}

function summarizeServerConfig() {
  const config = getServerConfig();
  if (!config) {
    return null;
  }

  return {
    availableEditors: config.availableEditors,
    environment: config.environment,
    issues: config.issues,
    keybindingsConfigPath: config.keybindingsConfigPath,
    observability: config.observability,
    providerCount: config.providers.length,
    providers: config.providers.map((provider) => ({
      authStatus: provider.auth.status,
      availability: provider.availability ?? "available",
      checkedAt: provider.checkedAt,
      displayName: provider.displayName ?? null,
      driver: provider.driver,
      enabled: provider.enabled,
      installed: provider.installed,
      instanceId: provider.instanceId,
      message: provider.message ?? null,
      modelCount: provider.models.length,
      skillCount: provider.skills.length,
      slashCommandCount: provider.slashCommands.length,
      status: provider.status,
      updateStatus: provider.updateState?.status ?? null,
      version: provider.version,
      versionAdvisory: provider.versionAdvisory ?? null,
    })),
  };
}

function summarizeEnvironmentConnections(activeEnvironmentId: EnvironmentId) {
  const savedRegistryById = useSavedEnvironmentRegistryStore.getState().byId;
  const savedRuntimeById = useSavedEnvironmentRuntimeStore.getState().byId;

  return listEnvironmentConnections().map((connection) => {
    const savedRuntime = savedRuntimeById[connection.environmentId] ?? null;
    const savedRecord = savedRegistryById[connection.environmentId] ?? null;
    return {
      activeThreadEnvironment: connection.environmentId === activeEnvironmentId,
      environmentId: connection.environmentId,
      kind: connection.kind,
      knownEnvironment: summarizeKnownEnvironment(connection.knownEnvironment),
      savedRecord: savedRecord
        ? {
            createdAt: savedRecord.createdAt,
            hasDesktopSsh: Boolean(savedRecord.desktopSsh),
            httpBaseUrl: redactUrl(savedRecord.httpBaseUrl),
            label: savedRecord.label,
            lastConnectedAt: savedRecord.lastConnectedAt,
            wsBaseUrl: redactUrl(savedRecord.wsBaseUrl),
          }
        : null,
      savedRuntime: savedRuntime
        ? {
            authState: savedRuntime.authState,
            connectedAt: savedRuntime.connectedAt,
            connectionState: savedRuntime.connectionState,
            descriptor: savedRuntime.descriptor,
            disconnectedAt: savedRuntime.disconnectedAt,
            lastError: savedRuntime.lastError,
            lastErrorAt: savedRuntime.lastErrorAt,
            role: savedRuntime.role,
            serverConfig: savedRuntime.serverConfig
              ? {
                  environment: savedRuntime.serverConfig.environment,
                  issueCount: savedRuntime.serverConfig.issues.length,
                  providerCount: savedRuntime.serverConfig.providers.length,
                }
              : null,
          }
        : null,
    };
  });
}

function summarizeAppStore(context: WebSocketDiagnosticsContext) {
  const appState = useStore.getState();
  const activeRef: ScopedThreadRef = {
    environmentId: context.activeThreadEnvironmentId,
    threadId: context.activeThreadId,
  };
  const activeEnvironmentState = selectEnvironmentState(
    appState,
    context.activeThreadEnvironmentId,
  );
  const activeThread = getThreadFromEnvironmentState(
    activeEnvironmentState,
    context.activeThreadId,
  );

  return {
    activeEnvironmentId: appState.activeEnvironmentId,
    activeThread: activeThread
      ? {
          archivedAt: activeThread.archivedAt,
          branch: activeThread.branch,
          detailPageInfo: activeThread.detailPageInfo ?? null,
          error: activeThread.error,
          interactionMode: activeThread.interactionMode,
          latestTurn: activeThread.latestTurn,
          messageCount: activeThread.messages.length,
          modelSelection: activeThread.modelSelection,
          projectId: activeThread.projectId,
          proposedPlanCount: activeThread.proposedPlans.length,
          queuedTurnCount: activeThread.queuedTurns.length,
          runtimeMode: activeThread.runtimeMode,
          session: activeThread.session,
          title: activeThread.title,
          turnDiffSummaryCount: activeThread.turnDiffSummaries.length,
          worktreePath: activeThread.worktreePath,
        }
      : null,
    activeThreadKey: scopedThreadKey(activeRef),
    environmentStates: Object.entries(appState.environmentStateById).map(
      ([environmentId, environmentState]) => ({
        active: environmentId === appState.activeEnvironmentId,
        activeThreadEnvironment: environmentId === context.activeThreadEnvironmentId,
        bootstrapComplete: environmentState.bootstrapComplete,
        environmentId,
        projectCount: environmentState.projectIds.length,
        sidebarThreadCount: Object.keys(environmentState.sidebarThreadSummaryById).length,
        threadCount: environmentState.threadIds.length,
      }),
    ),
  };
}

function summarizeTerminalEvent(event: TerminalEvent): JsonObject {
  const base = {
    createdAt: event.createdAt,
    terminalId: event.terminalId,
    threadId: event.threadId,
    type: event.type,
  };

  switch (event.type) {
    case "activity":
      return {
        ...base,
        hasRunningSubprocess: event.hasRunningSubprocess,
      };
    case "cleared":
      return base;
    case "error":
      return {
        ...base,
        message: event.message,
      };
    case "exited":
      return {
        ...base,
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      };
    case "output":
      return {
        ...base,
        dataBytes: bytesForText(event.data),
        dataChars: event.data.length,
      };
    case "restarted":
    case "started":
      return {
        ...base,
        snapshot: {
          cwd: event.snapshot.cwd,
          exitCode: event.snapshot.exitCode,
          exitSignal: event.snapshot.exitSignal,
          historyBytes: bytesForText(event.snapshot.history),
          pid: event.snapshot.pid,
          status: event.snapshot.status,
          updatedAt: event.snapshot.updatedAt,
          worktreePath: event.snapshot.worktreePath,
        },
      };
  }
}

function summarizeTerminalDiagnostics(context: WebSocketDiagnosticsContext) {
  const nowMs = Date.now();
  const terminalStore = useTerminalStateStore.getState();
  const activeRef: ScopedThreadRef = {
    environmentId: context.activeThreadEnvironmentId,
    threadId: context.activeThreadId,
  };
  const activeThreadKey = scopedThreadKey(activeRef);
  const activeThreadTerminalState = selectThreadTerminalState(
    terminalStore.terminalStateByThreadKey,
    activeRef,
  );
  const clientDiagnostics = getTerminalDiagnosticsSnapshot({
    nowMs,
    threadRef: activeRef,
  });

  const terminalEventBuffers = activeThreadTerminalState.terminalIds.map((terminalId) => {
    const entries = selectTerminalEventEntries(
      terminalStore.terminalEventEntriesByKey,
      activeRef,
      terminalId,
    );
    const countsByType: Partial<Record<TerminalEvent["type"], number>> = {};
    for (const entry of entries) {
      countsByType[entry.event.type] = (countsByType[entry.event.type] ?? 0) + 1;
    }
    const lastEntry = entries.at(-1) ?? null;
    const lastOutputEntry =
      entries.toReversed().find((entry) => entry.event.type === "output") ?? null;
    return {
      countsByType,
      eventCount: entries.length,
      lastEventAt: lastEntry?.event.createdAt ?? null,
      lastEventId: lastEntry?.id ?? null,
      lastOutputAt: lastOutputEntry?.event.createdAt ?? null,
      lastOutputEventId: lastOutputEntry?.id ?? null,
      msSinceLastEvent: msSinceIso(lastEntry?.event.createdAt ?? null, nowMs),
      msSinceLastOutput: msSinceIso(lastOutputEntry?.event.createdAt ?? null, nowMs),
      recentEvents: entries.slice(-MAX_RECENT_TERMINAL_EVENTS).map((entry) => ({
        id: entry.id,
        event: summarizeTerminalEvent(entry.event),
      })),
      terminalId,
    };
  });

  return {
    activeThreadKey,
    activeThreadTerminalState,
    bufferedTerminalEventKeyCount: Object.keys(terminalStore.terminalEventEntriesByKey).length,
    clientDiagnostics,
    launchContext: terminalStore.terminalLaunchContextByThreadKey[activeThreadKey] ?? null,
    nextTerminalEventId: terminalStore.nextTerminalEventId,
    terminalAvailable: context.terminalAvailable,
    terminalEventBuffers,
    terminalOpenProp: context.terminalOpen,
    terminalStateThreadKeyCount: Object.keys(terminalStore.terminalStateByThreadKey).length,
  };
}

function summarizeRpcRequests(nowMs: number) {
  const summarize = (request: SlowRpcAckRequest) => ({
    ageMs: Math.max(0, Math.round(nowMs - request.startedAtMs)),
    requestId: request.requestId,
    startedAt: request.startedAt,
    tag: request.tag,
    thresholdMs: request.thresholdMs,
  });

  return {
    pending: getPendingRpcAckRequests().map(summarize),
    slow: getSlowRpcAckRequests().map(summarize),
  };
}

function readNetworkInformation() {
  if (typeof navigator === "undefined") {
    return null;
  }
  const connection = (
    navigator as Navigator & {
      connection?: {
        downlink?: number;
        effectiveType?: string;
        rtt?: number;
        saveData?: boolean;
        type?: string;
      };
    }
  ).connection;
  if (!connection) {
    return null;
  }
  return {
    downlink: connection.downlink ?? null,
    effectiveType: connection.effectiveType ?? null,
    rtt: connection.rtt ?? null,
    saveData: connection.saveData ?? null,
    type: connection.type ?? null,
  };
}

function readUserAgentData() {
  if (typeof navigator === "undefined") {
    return null;
  }
  const userAgentData = (
    navigator as Navigator & {
      userAgentData?: {
        brands?: ReadonlyArray<{ brand: string; version: string }>;
        mobile?: boolean;
        platform?: string;
      };
    }
  ).userAgentData;
  if (!userAgentData) {
    return null;
  }
  return {
    brands: userAgentData.brands ?? [],
    mobile: userAgentData.mobile ?? null,
    platform: userAgentData.platform ?? null,
  };
}

function readNavigationTiming() {
  if (typeof performance === "undefined") {
    return null;
  }
  const navigation = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  if (!navigation) {
    return null;
  }
  const navigationWithActivation = navigation as PerformanceNavigationTiming & {
    readonly activationStart?: number;
  };
  return {
    activationStart: navigationWithActivation.activationStart ?? null,
    domComplete: navigation.domComplete,
    domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
    loadEventEnd: navigation.loadEventEnd,
    responseEnd: navigation.responseEnd,
    startTime: navigation.startTime,
    type: navigation.type,
  };
}

function readBrowserSnapshot(nowMs: number) {
  const doc =
    typeof document === "undefined"
      ? null
      : (document as Document & {
          prerendering?: boolean;
          wasDiscarded?: boolean;
        });
  return {
    document: doc
      ? {
          hasFocus: typeof doc.hasFocus === "function" ? doc.hasFocus() : null,
          hidden: doc.hidden,
          prerendering: doc.prerendering ?? null,
          referrer: redactUrl(doc.referrer),
          title: doc.title,
          visibilityState: doc.visibilityState,
          wasDiscarded: doc.wasDiscarded ?? null,
        }
      : null,
    historyLength: typeof history === "undefined" ? null : history.length,
    location: typeof window === "undefined" ? null : redactUrl(window.location.href),
    matchMedia:
      typeof window === "undefined" || typeof window.matchMedia !== "function"
        ? null
        : {
            displayModeBrowser: window.matchMedia("(display-mode: browser)").matches,
            displayModeStandalone: window.matchMedia("(display-mode: standalone)").matches,
            prefersReducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          },
    navigator:
      typeof navigator === "undefined"
        ? null
        : {
            cookieEnabled: navigator.cookieEnabled,
            hardwareConcurrency: navigator.hardwareConcurrency,
            language: navigator.language,
            languages: navigator.languages,
            maxTouchPoints: navigator.maxTouchPoints,
            onLine: navigator.onLine,
            platform: navigator.platform,
            serviceWorkerController:
              navigator.serviceWorker?.controller?.scriptURL === undefined
                ? null
                : redactUrl(navigator.serviceWorker.controller.scriptURL),
            userAgent: navigator.userAgent,
            userAgentData: readUserAgentData(),
          },
    networkInformation: readNetworkInformation(),
    performance:
      typeof performance === "undefined"
        ? null
        : {
            memory:
              (
                performance as Performance & {
                  memory?: {
                    jsHeapSizeLimit?: number;
                    totalJSHeapSize?: number;
                    usedJSHeapSize?: number;
                  };
                }
              ).memory ?? null,
            navigation: readNavigationTiming(),
            nowMs: Math.round(performance.now()),
            timeOrigin: performance.timeOrigin,
          },
    screen:
      typeof screen === "undefined"
        ? null
        : {
            availHeight: screen.availHeight,
            availWidth: screen.availWidth,
            colorDepth: screen.colorDepth,
            height: screen.height,
            orientation:
              screen.orientation === undefined
                ? null
                : {
                    angle: screen.orientation.angle,
                    type: screen.orientation.type,
                  },
            pixelDepth: screen.pixelDepth,
            width: screen.width,
          },
    viewport:
      typeof window === "undefined"
        ? null
        : {
            devicePixelRatio: window.devicePixelRatio,
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            outerHeight: window.outerHeight,
            outerWidth: window.outerWidth,
          },
    wallClockMs: nowMs,
  };
}

function summarizeResumeDiagnostics() {
  return getResumeDiagnosticsEntries().slice(-MAX_RESUME_DIAGNOSTIC_ENTRIES);
}

function buildInterpretation(input: {
  readonly pendingRequestCount: number;
  readonly slowRequestCount: number;
  readonly status: ReturnType<typeof getWsConnectionStatus>;
  readonly terminalClientDiagnostics: ReturnType<typeof getTerminalDiagnosticsSnapshot>;
  readonly terminalRunningCount: number;
  readonly uiState: string;
}): string[] {
  const notes: string[] = [];
  if (input.status.phase !== "connected") {
    notes.push(`WebSocket phase is ${input.status.phase} and UI state is ${input.uiState}.`);
  }
  if (input.status.heartbeatTimeoutCount > 0) {
    notes.push(
      `Heartbeat timeouts observed: ${input.status.heartbeatTimeoutCount.toString()} total.`,
    );
  }
  if (input.status.reconnectPhase === "exhausted") {
    notes.push("Reconnect retries are exhausted.");
  }
  if (input.slowRequestCount > 0) {
    notes.push(`${input.slowRequestCount.toString()} RPC request(s) are past the slow threshold.`);
  } else if (input.pendingRequestCount > 0) {
    notes.push(`${input.pendingRequestCount.toString()} RPC request(s) are waiting for an ack.`);
  }
  if (input.terminalRunningCount > 0) {
    notes.push(`${input.terminalRunningCount.toString()} terminal session(s) are marked running.`);
  }
  if ((input.terminalClientDiagnostics.countsByKind["write-error"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["write-error"],
      )} terminal write error(s) were recorded by the client.`,
    );
  }
  if ((input.terminalClientDiagnostics.countsByKind["open-retry-scheduled"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["open-retry-scheduled"],
      )} terminal open retry attempt(s) were scheduled after transport interruption.`,
    );
  }
  if ((input.terminalClientDiagnostics.countsByKind["terminal-resync-started"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["terminal-resync-started"],
      )} manual terminal resync attempt(s) were started.`,
    );
  }
  if ((input.terminalClientDiagnostics.countsByKind["terminal-resync-failed"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["terminal-resync-failed"],
      )} manual terminal resync attempt(s) failed.`,
    );
  }
  if ((input.terminalClientDiagnostics.countsByKind["terminal-restart-confirmed"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["terminal-restart-confirmed"],
      )} manual terminal restart attempt(s) were confirmed.`,
    );
  }
  if ((input.terminalClientDiagnostics.countsByKind["terminal-restart-failed"] ?? 0) > 0) {
    notes.push(
      `${String(
        input.terminalClientDiagnostics.countsByKind["terminal-restart-failed"],
      )} manual terminal restart attempt(s) failed.`,
    );
  }
  if (input.terminalClientDiagnostics.pendingWrites.length > 0) {
    notes.push(
      `${input.terminalClientDiagnostics.pendingWrites.length.toString()} terminal write request(s) are still pending.`,
    );
  }
  for (const recovery of Object.values(input.terminalClientDiagnostics.terminalRecoveryById)) {
    if (recovery.writesSinceLastOutput > 0) {
      notes.push(
        `Terminal ${recovery.terminalId} has ${recovery.writesSinceLastOutput.toString()} successful write(s) since the last observed output.`,
      );
    }
    if (
      recovery.lastWriteSuccessAt !== null &&
      (recovery.lastTerminalEventAt === null ||
        recovery.lastWriteSuccessAt > recovery.lastTerminalEventAt)
    ) {
      notes.push(
        `Terminal ${recovery.terminalId} has no applied terminal event newer than its latest successful write.`,
      );
    }
    if (recovery.currentRecoveryState !== "idle") {
      notes.push(
        `Terminal ${recovery.terminalId} recovery state is ${recovery.currentRecoveryState}.`,
      );
    }
  }
  return notes.length > 0 ? notes : ["No immediate client-side WebSocket anomaly is flagged."];
}

export function buildWebSocketDiagnosticsReport(context: WebSocketDiagnosticsContext): string {
  const generatedAt = isoNow();
  const nowMs = Date.now();
  const status = getWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const terminalDiagnostics = summarizeTerminalDiagnostics(context);
  const rpcRequests = summarizeRpcRequests(nowMs);
  const redactedStatus = {
    ...status,
    socketUrl: redactUrl(status.socketUrl),
  };
  const terminalRunningCount =
    terminalDiagnostics.activeThreadTerminalState.runningTerminalIds.length;
  const activeTerminalRecovery =
    terminalDiagnostics.clientDiagnostics.terminalRecoveryById[
      terminalDiagnostics.activeThreadTerminalState.activeTerminalId
    ] ?? null;
  const interpretation = buildInterpretation({
    pendingRequestCount: rpcRequests.pending.length,
    slowRequestCount: rpcRequests.slow.length,
    status,
    terminalClientDiagnostics: terminalDiagnostics.clientDiagnostics,
    terminalRunningCount,
    uiState,
  });

  const report = {
    appStore: summarizeAppStore(context),
    browser: readBrowserSnapshot(nowMs),
    environmentConnections: summarizeEnvironmentConnections(context.activeThreadEnvironmentId),
    primaryEnvironment: {
      descriptor: readPrimaryDescriptorForDiagnostics(),
      knownEnvironment: summarizeKnownEnvironment(readPrimaryKnownEnvironmentForDiagnostics()),
    },
    resumeDiagnostics: summarizeResumeDiagnostics(),
    rpcRequests,
    serverConfig: summarizeServerConfig(),
    serverConfigUpdatedNotification: getServerConfigUpdatedNotification(),
    terminal: terminalDiagnostics,
    websocket: {
      msSinceConnected: msSinceIso(status.connectedAt, nowMs),
      msSinceDisconnected: msSinceIso(status.disconnectedAt, nowMs),
      msSinceLastAttempt: msSinceIso(status.lastAttemptAt, nowMs),
      msSinceLastError: msSinceIso(status.lastErrorAt, nowMs),
      msSinceLastHeartbeatPing: msSinceIso(status.lastHeartbeatPingAt, nowMs),
      msSinceLastHeartbeatPong: msSinceIso(status.lastHeartbeatPongAt, nowMs),
      msSinceLastHeartbeatTimeout: msSinceIso(status.lastHeartbeatTimeoutAt, nowMs),
      msUntilNextRetry: msUntilIso(status.nextRetryAt, nowMs),
      status: redactedStatus,
      uiState,
    },
  };

  const lines = [
    "# WebSocket diagnostics note",
    "",
    `Generated at: ${generatedAt}`,
    "Sensitive URL query values and credential-like fields are redacted.",
    "",
    "## Active context",
    `- Thread: ${context.activeThreadTitle} (${context.activeThreadId})`,
    `- Environment: ${context.activeThreadEnvironmentId}`,
    `- Project: ${context.activeProjectName ?? "none"}`,
    `- Open cwd: ${context.openInCwd ?? "none"}`,
    `- Git cwd: ${context.gitCwd ?? "none"}`,
    `- Terminal: ${context.terminalAvailable ? "available" : "unavailable"}, ${
      context.terminalOpen ? "open" : "closed"
    }`,
    `- Panels: sourceControl=${String(context.sourceControlOpen)}, diff=${String(
      context.diffOpen,
    )}, fileExplorer=${String(context.fileExplorerOpen)} (available=${String(
      context.fileExplorerAvailable,
    )})`,
    "",
    "## WebSocket summary",
    `- UI state: ${uiState}`,
    `- Phase: ${status.phase}`,
    `- Socket ready state: ${status.socketReadyState ?? "unknown"}`,
    `- Reconnect phase: ${status.reconnectPhase}`,
    `- Attempts: ${status.attemptCount.toString()} total, ${status.reconnectAttemptCount.toString()}/${status.reconnectMaxAttempts.toString()} in current reconnect cycle`,
    `- Browser online: ${String(status.online)}`,
    `- Last connected: ${status.connectedAt ?? "never"} (${formatMs(
      msSinceIso(status.connectedAt, nowMs),
    )} ago)`,
    `- Last disconnected: ${status.disconnectedAt ?? "never"} (${formatMs(
      msSinceIso(status.disconnectedAt, nowMs),
    )} ago)`,
    `- Next retry: ${status.nextRetryAt ?? "none"} (${formatMs(
      msUntilIso(status.nextRetryAt, nowMs),
    )})`,
    `- Last error: ${status.lastError ?? "none"}`,
    `- Last close: code=${status.closeCode ?? "none"} reason=${status.closeReason ?? "none"}`,
    `- Heartbeats: ping=${status.heartbeatPingCount.toString()} pong=${status.heartbeatPongCount.toString()} timeout=${status.heartbeatTimeoutCount.toString()}`,
    "",
    "## Terminal client summary",
    `- Recent diagnostic events: ${terminalDiagnostics.clientDiagnostics.returnedEventCount.toString()} for active thread (${terminalDiagnostics.clientDiagnostics.totalEventCount.toString()} total retained)`,
    `- Terminal input events: ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["input-received"] ?? 0,
    )}`,
    `- Terminal write attempts: ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["write-start"] ?? 0,
    )} started, ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["write-success"] ?? 0,
    )} succeeded, ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["write-error"] ?? 0,
    )} failed, ${terminalDiagnostics.clientDiagnostics.pendingWrites.length.toString()} pending`,
    `- Terminal open lifecycle: ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["open-start"] ?? 0,
    )} opened, ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["open-success"] ?? 0,
    )} succeeded, ${String(
      terminalDiagnostics.clientDiagnostics.countsByKind["open-error"] ?? 0,
    )} failed`,
    `- Terminal recovery state: ${activeTerminalRecovery?.currentRecoveryState ?? "unknown"}`,
    `- Last terminal event: ${
      activeTerminalRecovery?.lastTerminalEventAt
        ? new Date(activeTerminalRecovery.lastTerminalEventAt).toISOString()
        : "none"
    }`,
    `- Last terminal output: ${
      activeTerminalRecovery?.lastOutputAt
        ? new Date(activeTerminalRecovery.lastOutputAt).toISOString()
        : "none"
    } (${formatMs(activeTerminalRecovery?.msSinceLastOutput ?? null)} ago)`,
    `- Last terminal input: ${
      activeTerminalRecovery?.lastInputAt
        ? new Date(activeTerminalRecovery.lastInputAt).toISOString()
        : "none"
    }`,
    `- Last write success: ${
      activeTerminalRecovery?.lastWriteSuccessAt
        ? new Date(activeTerminalRecovery.lastWriteSuccessAt).toISOString()
        : "none"
    }; writes since last output=${String(activeTerminalRecovery?.writesSinceLastOutput ?? 0)}`,
    "",
    "## Interpretation",
    ...interpretation.map((note) => `- ${note}`),
    "",
    "## Raw snapshot",
    jsonBlock(redactRecordValues(report)),
    "",
  ];

  return lines.join("\n");
}

export function buildWebSocketDiagnosticsFilename(generatedAt = isoNow()): string {
  return `websocket-diagnostics-${generatedAt.replace(/[:.]/g, "-")}.md`;
}

export function exportWebSocketDiagnosticsNote(
  context: WebSocketDiagnosticsContext,
): WebSocketDiagnosticsExportResult {
  const generatedAt = isoNow();
  const filename = buildWebSocketDiagnosticsFilename(generatedAt);
  downloadPlanAsTextFile(filename, buildWebSocketDiagnosticsReport(context));
  return { filename };
}
