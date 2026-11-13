// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import {
  DEFAULT_TERMINAL_ID,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  TerminalCwdError,
  TerminalCwdNotDirectoryError,
  TerminalCwdNotFoundError,
  TerminalCwdStatError,
  TerminalError,
  TerminalHistoryError,
  TerminalNotRunningError,
  TerminalProviderInstanceNotFoundError,
  TerminalProviderEnvironmentError,
  TerminalResizeError,
  TerminalSessionLookupError,
  TerminalWriteError,
  type TerminalAttachInput,
  type TerminalAttachStreamEvent,
  type TerminalClearInput,
  type TerminalCloseInput,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type TerminalOpenInput,
  type TerminalObserveInput,
  type TerminalResizeInput,
  type ResourceMonitorProcessTableEntry,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type TerminalSummary,
  type TerminalWriteInput,
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { makeKeyedCoalescingWorker } from "@t3tools/shared/KeyedCoalescingWorker";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { mergePathEntries } from "@t3tools/shared/shell";

import { acpRegistryManagedBinaryDirectories } from "@t3tools/provider-acp-registry/server";
import { getTerminalLabel } from "@t3tools/shared/terminalLabels";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

import * as ServerConfig from "../config.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";
import { increment, terminalSessionsTotal } from "../observability/Metrics.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProcessRunner from "../processRunner.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as NativeTelemetryClient from "../resourceTelemetry/NativeTelemetryClient.ts";
import { terminalOutputStream } from "./OutputProtocol.ts";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";

export * from "./terminalSupport0.ts";
export * from "./terminalSupport1.ts";
export * from "./terminalSupport2.ts";

export class TerminalManager extends Context.Service<
  TerminalManager,
  {
    readonly open: (
      input: TerminalOpenInput,
    ) => Effect.Effect<TerminalSessionSnapshot, TerminalError>;

    readonly getShell: (input: TerminalObserveInput) => Effect.Effect<string, TerminalError>;

    /**
     * Attached viewers share one PTY sized to the smallest of them, so a narrow client
     * still sees the whole TUI. Streams and resizes with the same `viewerId` (one client
     * connection) count as one viewer; streams without one are each their own viewer.
     */
    readonly attachStream: (
      input: TerminalAttachInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
      viewerId?: string,
    ) => Effect.Effect<() => void, TerminalError>;

    /**
     * The `terminal.attach` RPC stream. Overflow recovery swaps the inner subscription, so
     * `viewerId` and the size it reported stay attached until the whole stream ends.
     */
    readonly attachOutputStream: (
      input: TerminalAttachInput,
      viewerId: string,
    ) => Stream.Stream<TerminalAttachStreamEvent, TerminalError>;

    readonly observeStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly resyncStream: (
      input: TerminalObserveInput,
      listener: (event: TerminalAttachStreamEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void, TerminalError>;

    readonly write: (input: TerminalWriteInput) => Effect.Effect<void, TerminalError>;

    readonly resize: (
      input: TerminalResizeInput,
      viewerId?: string,
    ) => Effect.Effect<void, TerminalError>;

    readonly clear: (input: TerminalClearInput) => Effect.Effect<void, TerminalError>;

    /** Omit terminalId to close all sessions for the thread. */
    readonly close: (input: TerminalCloseInput) => Effect.Effect<void, TerminalError>;

    readonly closeIdle: (input: {
      readonly threadId: string;
      readonly terminalId?: string;
    }) => Effect.Effect<void>;

    readonly subscribe: (
      listener: (event: TerminalEvent) => Effect.Effect<void>,
      registerCleanup?: (stop: () => void) => void,
    ) => Effect.Effect<() => void>;

    readonly subscribeMetadata: (
      listener: (event: TerminalMetadataStreamEvent) => Effect.Effect<void>,
    ) => Effect.Effect<() => void>;
  }
>()("t3/terminal/Manager/TerminalManager") {}


export const make = Effect.fn("TerminalManager.make")(function* () {
  const { terminalLogsDir, providerStatusCacheDir, baseDir } = yield* ServerConfig.ServerConfig;
  const ptyAdapter = yield* PtyAdapter.PtyAdapter;
  const portDiscovery = yield* PortScanner.PortDiscovery;
  const nativeTelemetry = yield* NativeTelemetryClient.NativeTelemetryClient;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const resolveProviderInstanceEnvironment = Effect.fn(
    "terminal.resolveProviderInstanceEnvironment",
  )((rawProviderInstanceId: string, env: Record<string, string> | undefined) =>
    resolveProviderInstanceTerminalEnvironment({
      serverSettings,
      path,
      rawProviderInstanceId,
      env,
    }),
  );
  return yield* makeWithOptions({
    logsDir: terminalLogsDir,
    ptyAdapter,
    processTable: nativeTelemetry.processTable.pipe(
      Effect.mapError(
        (cause) => new TerminalSubprocessCheckError({ cause, command: "resource-monitor" }),
      ),
    ),
    managedBinaryCacheDir: providerStatusCacheDir,
    managedBinaryToolsDir: path.join(baseDir, "tools"),
    registerTerminalProcesses: portDiscovery.registerTerminalProcesses,
    unregisterTerminal: portDiscovery.unregisterTerminal,
    resolveProviderInstanceEnvironment,
  });
});

import type { TerminalManagerOptions } from "./terminalSupport2.ts";
import { TerminalSubprocessCheckError } from "./terminalSupport0.ts";
import { resolveProviderInstanceTerminalEnvironment } from "./terminalSupport1.ts";
import { install0 } from "./terminalManagerPart0.ts";
import { install1 } from "./terminalManagerPart1.ts";
import { install2 } from "./terminalManagerPart2.ts";
import { install3 } from "./terminalManagerPart3.ts";

export const makeWithOptions = Effect.fn("TerminalManager.makeWithOptions")(function* (
  options: TerminalManagerOptions,
) {
  const d0 = yield* install0({ options });
  const d1 = Object.assign(d0, yield* install1(d0));
  const d2 = Object.assign(d1, yield* install2(d1));
  const d3 = Object.assign(d2, yield* install3(d2));
  return TerminalManager.of({
    open: d3.open,
    getShell: d3.getShell,
    attachStream: d3.attachStream,
    attachOutputStream: d3.attachOutputStream,
    observeStream: d3.observeStream,
    resyncStream: d3.resyncStream,
    write: d3.write,
    resize: d3.resize,
    clear: d3.clear,
    close: d3.close,
    closeIdle: d3.closeIdle,
    subscribe: d3.subscribe,
    subscribeMetadata: d3.subscribeMetadata,
  });
});

export const layer = Layer.effect(TerminalManager, make()).pipe(Layer.provide(ProcessRunner.layer));




