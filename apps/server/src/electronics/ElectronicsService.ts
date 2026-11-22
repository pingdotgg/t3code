import {
  type ElectronicsCircuitModel,
  ElectronicsError,
  type ElectronicsListFilesResult,
  type ElectronicsPanelTab,
  type ElectronicsServiceState,
  type ElectronicsSimulateInput,
  type ElectronicsSimulationResult,
  type ElectronicsThreadSession,
  type ElectronicsToolchainStatus,
  type ElectronicsTracePathInput,
  type ElectronicsTracePathResult,
  type ElectronicsValidateInput,
  type ElectronicsValidationReport,
  type ElectronicsValidationSource,
  type ElectronicsWorkspaceFile,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import { runBuiltinMnaSimulation } from "./mnaSolver.ts";
import { detectElectronicsFormat, parseElectronicsFile } from "./parsers.ts";
import { traceCircuitPath } from "./pathTracer.ts";
import { probeBinary, runKiCadExternalValidation, runNgspiceSimulation } from "./toolchain.ts";
import { assembleValidationReport, runBuiltinCircuitValidation } from "./validator.ts";

const MAX_CIRCUIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_FILES = 200;

const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".t3",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "coverage",
]);

export class ElectronicsService extends Context.Service<
  ElectronicsService,
  {
    readonly getState: Effect.Effect<ElectronicsServiceState>;
    readonly subscribeState: Stream.Stream<ElectronicsServiceState>;
    readonly getToolchainStatus: (
      refresh?: boolean,
    ) => Effect.Effect<ElectronicsToolchainStatus, ElectronicsError>;
    readonly listFiles: (
      cwd: string,
    ) => Effect.Effect<ElectronicsListFilesResult, ElectronicsError>;
    readonly inspect: (
      cwd: string,
      filePath: string,
    ) => Effect.Effect<ElectronicsCircuitModel, ElectronicsError>;
    readonly tracePath: (
      input: ElectronicsTracePathInput,
      threadId?: ThreadId,
    ) => Effect.Effect<ElectronicsTracePathResult, ElectronicsError>;
    readonly validate: (
      input: ElectronicsValidateInput,
      threadId?: ThreadId,
    ) => Effect.Effect<ElectronicsValidationReport, ElectronicsError>;
    readonly simulate: (
      input: ElectronicsSimulateInput,
      threadId?: ThreadId,
    ) => Effect.Effect<ElectronicsSimulationResult, ElectronicsError>;
    readonly openPanel: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
    }) => Effect.Effect<ElectronicsThreadSession, ElectronicsError>;
    readonly closePanel: (threadId: ThreadId) => Effect.Effect<void, ElectronicsError>;
    readonly getThreadSession: (
      threadId: ThreadId,
    ) => Effect.Effect<ElectronicsThreadSession | undefined>;
  }
>()("t3/electronics/ElectronicsService") {}

export const layer = Layer.effect(
  ElectronicsService,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const sessionsRef = yield* Ref.make<Map<ThreadId, ElectronicsThreadSession>>(new Map());
    const closeGenRef = yield* Ref.make<Map<ThreadId, number>>(new Map());
    const lastUpdatedMsRef = yield* Ref.make<Map<ThreadId, number>>(new Map());
    const toolchainCacheRef = yield* Ref.make<ElectronicsToolchainStatus | null>(null);
    const updates = yield* PubSub.unbounded<ElectronicsServiceState>();

    const getSettings = serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ElectronicsError({
            code: "internal",
            message: "Unable to read server settings.",
            cause,
          }),
      ),
    );

    const ensureEnabled = Effect.gen(function* () {
      const settings = yield* getSettings;
      if (!settings.enableElectronicsWorkbench) {
        return yield* new ElectronicsError({
          code: "disabled",
          message: "Electronics Workbench is disabled in Settings → Electronics.",
        });
      }
      return settings;
    });

    const probeToolchain = Effect.fn("ElectronicsService.probeToolchain")(function* (
      forceRefresh = false,
    ) {
      const settings = yield* getSettings;
      const cached = yield* Ref.get(toolchainCacheRef);
      if (
        !forceRefresh &&
        cached !== null &&
        cached.enabled === settings.enableElectronicsWorkbench &&
        cached.allowExternalTools === settings.electronicsAllowExternalTools &&
        cached.agentAccessEnabled === settings.enableAgentElectronicsAccess
      ) {
        return cached;
      }
      const [kicadCli, ngspice] = settings.electronicsAllowExternalTools
        ? yield* Effect.all([
            probeBinary("kicad-cli", settings.electronicsKicadCliPath).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
            probeBinary("ngspice", settings.electronicsNgspicePath).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
          ])
        : [
            {
              name: "kicad-cli" as const,
              available: false,
              error: "External tools disabled in Settings → Electronics.",
            },
            {
              name: "ngspice" as const,
              available: false,
              error: "External tools disabled in Settings → Electronics.",
            },
          ];

      const status: ElectronicsToolchainStatus = {
        enabled: settings.enableElectronicsWorkbench,
        allowExternalTools: settings.electronicsAllowExternalTools,
        agentAccessEnabled: settings.enableAgentElectronicsAccess,
        kicadCli,
        ngspice,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* Ref.set(toolchainCacheRef, status);
      return status;
    });

    const buildState = Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const toolchain = yield* probeToolchain(false).pipe(
        Effect.orElseSucceed((): ElectronicsToolchainStatus => ({
          enabled: true,
          allowExternalTools: true,
          agentAccessEnabled: true,
          kicadCli: { name: "kicad-cli", available: false },
          ngspice: { name: "ngspice", available: false },
          checkedAt: nowIso,
        })),
      );
      const sessions = Array.from((yield* Ref.get(sessionsRef)).values());
      return { toolchain, sessions } satisfies ElectronicsServiceState;
    });

    const broadcast = Effect.gen(function* () {
      const state = yield* buildState;
      yield* PubSub.publish(updates, state);
    });

    const resolveWorkspaceFile = Effect.fn("ElectronicsService.resolveWorkspaceFile")(function* (
      cwd: string,
      requestedPath: string,
    ) {
      if (requestedPath.includes("\0")) {
        return yield* new ElectronicsError({
          code: "invalid_path",
          message: "Invalid file path.",
        });
      }
      const rootReal = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
      const candidate = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(rootReal, requestedPath);

      const lexicalRelative = path.relative(rootReal, candidate);
      if (lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative)) {
        return yield* new ElectronicsError({
          code: "invalid_path",
          message: `Path "${requestedPath}" escapes the workspace root.`,
        });
      }

      const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
      if (!exists) {
        return yield* new ElectronicsError({
          code: "not_found",
          message: `Electronics file "${requestedPath}" was not found in workspace.`,
        });
      }
      const targetReal = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate));

      const relative = path.relative(rootReal, targetReal);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        return yield* new ElectronicsError({
          code: "invalid_path",
          message: `Path "${requestedPath}" escapes the workspace root.`,
        });
      }

      const stat = yield* fs.stat(targetReal).pipe(
        Effect.mapError(
          () =>
            new ElectronicsError({
              code: "not_found",
              message: `Unable to stat "${requestedPath}".`,
            }),
        ),
      );
      if (stat.type !== "File") {
        return yield* new ElectronicsError({
          code: "invalid_path",
          message: `"${requestedPath}" is not a regular file.`,
        });
      }
      if (Number(stat.size) > MAX_CIRCUIT_FILE_BYTES) {
        return yield* new ElectronicsError({
          code: "parse_failed",
          message: `File "${relative}" exceeds the ${MAX_CIRCUIT_FILE_BYTES / (1024 * 1024)} MB circuit file limit.`,
        });
      }
      const format = detectElectronicsFormat(relative);
      if (!format) {
        return yield* new ElectronicsError({
          code: "unsupported_format",
          message: `Unsupported electronics file "${relative}". Supported: .kicad_sch, .kicad_pcb, .cir/.sp/.spice/.net, *.circuit.json.`,
        });
      }

      return {
        absolutePath: targetReal,
        relativePath: relative.replaceAll("\\", "/"),
        format,
      };
    });

    const loadAndParse = Effect.fn("ElectronicsService.loadAndParse")(function* (
      cwd: string,
      requestedPath: string,
    ) {
      const resolved = yield* resolveWorkspaceFile(cwd, requestedPath);
      const content = yield* fs.readFileString(resolved.absolutePath).pipe(
        Effect.mapError(
          (cause) =>
            new ElectronicsError({
              code: "parse_failed",
              message: `Failed reading "${resolved.relativePath}".`,
              cause,
            }),
        ),
      );
      const model = yield* Effect.try({
        try: () => parseElectronicsFile(resolved.relativePath, content),
        catch: (cause) =>
          new ElectronicsError({
            code: "parse_failed",
            message: `Failed parsing "${resolved.relativePath}".`,
            cause,
          }),
      });
      return { ...resolved, content, model };
    });

    const listFiles = Effect.fn("ElectronicsService.listFiles")(function* (cwd: string) {
      yield* ensureEnabled;
      const rootReal = yield* fs.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
      const found: ElectronicsWorkspaceFile[] = [];

      const walk = Effect.fn("ElectronicsService.walk")(function* (
        dir: string,
        depth: number,
      ): Effect.fn.Return<void> {
        if (depth > MAX_DISCOVERY_DEPTH || found.length >= MAX_DISCOVERY_FILES) return;
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const entry of entries) {
          if (found.length >= MAX_DISCOVERY_FILES) break;
          if (IGNORED_DIRECTORIES.has(entry)) continue;
          const fullPath = path.join(dir, entry);
          const stat = yield* fs.stat(fullPath).pipe(Effect.orElseSucceed(() => null));
          if (!stat) continue;
          if (stat.type === "Directory") {
            yield* walk(fullPath, depth + 1);
          } else if (stat.type === "File") {
            const format = detectElectronicsFormat(entry);
            if (format) {
              const rel = path.relative(rootReal, fullPath).replaceAll("\\", "/");
              found.push({
                relativePath: rel,
                name: entry,
                format,
                sizeBytes: Number(stat.size),
              });
            }
          }
        }
      });

      yield* walk(rootReal, 0);
      found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
      const toolchain = yield* probeToolchain(false);
      return { files: found, toolchain } satisfies ElectronicsListFilesResult;
    });

    const currentCloseGeneration = (threadId: ThreadId) =>
      Ref.get(closeGenRef).pipe(Effect.map((m) => m.get(threadId) ?? 0));

    const nextMonotonicIso = Effect.fn("ElectronicsService.nextMonotonicIso")(function* (
      threadId: ThreadId,
    ) {
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      const nextMs = yield* Ref.modify(lastUpdatedMsRef, (map) => {
        const prev = map.get(threadId) ?? 0;
        const monotonic = Math.max(nowMs, prev + 1);
        const next = new Map(map);
        next.set(threadId, monotonic);
        return [monotonic, next] as const;
      });
      return DateTime.formatIso(DateTime.makeUnsafe(nextMs));
    });

    const updateThreadSession = Effect.fn("ElectronicsService.updateThreadSession")(function* (
      threadId: ThreadId,
      updater: (existing: ElectronicsThreadSession | undefined) => ElectronicsThreadSession,
      expectedCloseGen?: number,
    ) {
      const committed = yield* Effect.gen(function* () {
        if (expectedCloseGen !== undefined) {
          const gen = yield* currentCloseGeneration(threadId);
          if (gen !== expectedCloseGen) return null;
        }
        let nextSession: ElectronicsThreadSession | null = null;
        yield* Ref.update(sessionsRef, (map) => {
          const next = new Map(map);
          nextSession = updater(next.get(threadId));
          next.set(threadId, nextSession);
          return next;
        });
        return nextSession;
      });
      if (committed !== null) {
        yield* broadcast;
      }
      return committed;
    });

    const inspect = Effect.fn("ElectronicsService.inspect")(function* (
      cwd: string,
      filePath: string,
    ) {
      yield* ensureEnabled;
      const loaded = yield* loadAndParse(cwd, filePath);
      return loaded.model;
    });

    const tracePath = Effect.fn("ElectronicsService.tracePath")(function* (
      input: ElectronicsTracePathInput,
      threadId?: ThreadId,
    ) {
      yield* ensureEnabled;
      const startGen = threadId !== undefined ? yield* currentCloseGeneration(threadId) : undefined;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const result = traceCircuitPath(loaded.model, {
        from: input.from,
        ...(input.to !== undefined ? { to: input.to } : {}),
        ...(input.traversePassives !== undefined
          ? { traversePassives: input.traversePassives }
          : {}),
        ...(input.maxHops !== undefined ? { maxHops: input.maxHops } : {}),
      });
      if (threadId !== undefined) {
        const now = yield* nextMonotonicIso(threadId);
        yield* updateThreadSession(
          threadId,
          (existing) => ({
            threadId,
            filePath: loaded.relativePath,
            format: loaded.format,
            activeTab: "trace",
            ...(result.highlightedNets[0] !== undefined
              ? { selectedNet: result.highlightedNets[0] }
              : {}),
            lastTrace: result,
            ...(existing?.lastValidation !== undefined && existing.filePath === loaded.relativePath
              ? { lastValidation: existing.lastValidation }
              : {}),
            ...(existing?.lastSimulation !== undefined && existing.filePath === loaded.relativePath
              ? { lastSimulation: existing.lastSimulation }
              : {}),
            openedAt: existing?.openedAt ?? now,
            updatedAt: now,
          }),
          startGen,
        );
      }
      return result;
    });

    const validate = Effect.fn("ElectronicsService.validate")(function* (
      input: ElectronicsValidateInput,
      threadId?: ThreadId,
    ) {
      const settings = yield* ensureEnabled;
      const startGen = threadId !== undefined ? yield* currentCloseGeneration(threadId) : undefined;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const builtin = runBuiltinCircuitValidation(loaded.model);
      const enginesUsed: ElectronicsValidationSource[] = ["builtin"];
      const notes = [...builtin.notes];
      const externalIssues = [];

      const wantExternal =
        (input.useExternalToolchain ?? true) && settings.electronicsAllowExternalTools;

      if (wantExternal && (loaded.format === "kicad_sch" || loaded.format === "kicad_pcb")) {
        const toolchain = yield* probeToolchain(false);
        if (toolchain.kicadCli.available) {
          const ext = yield* runKiCadExternalValidation({
            absolutePath: loaded.absolutePath,
            format: loaded.format,
            ...(settings.electronicsKicadCliPath
              ? { kicadCliPath: settings.electronicsKicadCliPath }
              : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
          if (ext.ran) {
            enginesUsed.push(ext.source);
            externalIssues.push(...ext.issues);
          } else if (ext.note) {
            notes.push(ext.note);
          }
        } else {
          notes.push(
            "kicad-cli is not installed on this environment; ran built-in pure-TypeScript electrical & layout checks.",
          );
        }
      }

      const report = assembleValidationReport({
        model: loaded.model,
        builtinIssues: builtin.issues,
        externalIssues,
        enginesUsed,
        notes,
      });

      if (threadId !== undefined) {
        const now = yield* nextMonotonicIso(threadId);
        yield* updateThreadSession(
          threadId,
          (existing) => ({
            threadId,
            filePath: loaded.relativePath,
            format: loaded.format,
            activeTab: "checks",
            ...(existing?.selectedNet !== undefined && existing.filePath === loaded.relativePath
              ? { selectedNet: existing.selectedNet }
              : {}),
            ...(existing?.lastTrace !== undefined && existing.filePath === loaded.relativePath
              ? { lastTrace: existing.lastTrace }
              : {}),
            lastValidation: report,
            ...(existing?.lastSimulation !== undefined && existing.filePath === loaded.relativePath
              ? { lastSimulation: existing.lastSimulation }
              : {}),
            openedAt: existing?.openedAt ?? now,
            updatedAt: now,
          }),
          startGen,
        );
      }

      return report;
    });

    const simulate = Effect.fn("ElectronicsService.simulate")(function* (
      input: ElectronicsSimulateInput,
      threadId?: ThreadId,
    ) {
      const settings = yield* ensureEnabled;
      const startGen = threadId !== undefined ? yield* currentCloseGeneration(threadId) : undefined;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const kind = input.kind ?? "dc_op";

      let result: ElectronicsSimulationResult | null = null;
      const wantExternal =
        (input.useExternalToolchain ?? true) && settings.electronicsAllowExternalTools;

      if (wantExternal && loaded.format === "spice") {
        const toolchain = yield* probeToolchain(false);
        if (toolchain.ngspice.available) {
          result = yield* runNgspiceSimulation({
            model: loaded.model,
            spiceSource: loaded.content,
            workspaceRoot: input.cwd,
            sourceFilePath: loaded.absolutePath,
            kind,
            ...(settings.electronicsNgspicePath
              ? { ngspicePath: settings.electronicsNgspicePath }
              : {}),
            ...(input.outputNode !== undefined ? { outputNode: input.outputNode } : {}),
            ...(input.startFreqHz !== undefined ? { startFreqHz: input.startFreqHz } : {}),
            ...(input.stopFreqHz !== undefined ? { stopFreqHz: input.stopFreqHz } : {}),
            ...(input.pointsPerDecade !== undefined
              ? { pointsPerDecade: input.pointsPerDecade }
              : {}),
            ...(input.stopTimeSeconds !== undefined
              ? { stopTimeSeconds: input.stopTimeSeconds }
              : {}),
            ...(input.stepTimeSeconds !== undefined
              ? { stepTimeSeconds: input.stepTimeSeconds }
              : {}),
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          );
        }
      }

      if (result === null) {
        result = yield* Effect.try({
          try: () =>
            runBuiltinMnaSimulation(loaded.model, {
              kind,
              ...(input.outputNode !== undefined ? { outputNode: input.outputNode } : {}),
              ...(input.startFreqHz !== undefined ? { startFreqHz: input.startFreqHz } : {}),
              ...(input.stopFreqHz !== undefined ? { stopFreqHz: input.stopFreqHz } : {}),
              ...(input.pointsPerDecade !== undefined
                ? { pointsPerDecade: input.pointsPerDecade }
                : {}),
              ...(input.stopTimeSeconds !== undefined
                ? { stopTimeSeconds: input.stopTimeSeconds }
                : {}),
              ...(input.stepTimeSeconds !== undefined
                ? { stepTimeSeconds: input.stepTimeSeconds }
                : {}),
            }),
          catch: (cause) =>
            new ElectronicsError({
              code: "simulation_failed",
              message: cause instanceof Error ? cause.message : "Circuit simulation failed.",
              cause,
            }),
        });
      }

      if (threadId !== undefined) {
        const now = yield* nextMonotonicIso(threadId);
        yield* updateThreadSession(
          threadId,
          (existing) => ({
            threadId,
            filePath: loaded.relativePath,
            format: loaded.format,
            activeTab: "simulate",
            ...(existing?.selectedNet !== undefined && existing.filePath === loaded.relativePath
              ? { selectedNet: existing.selectedNet }
              : {}),
            ...(existing?.lastTrace !== undefined && existing.filePath === loaded.relativePath
              ? { lastTrace: existing.lastTrace }
              : {}),
            ...(existing?.lastValidation !== undefined && existing.filePath === loaded.relativePath
              ? { lastValidation: existing.lastValidation }
              : {}),
            lastSimulation: result,
            openedAt: existing?.openedAt ?? now,
            updatedAt: now,
          }),
          startGen,
        );
      }

      return result;
    });

    const openPanel = Effect.fn("ElectronicsService.openPanel")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
    }) {
      yield* ensureEnabled;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const now = yield* nextMonotonicIso(input.threadId);
      const session = yield* updateThreadSession(input.threadId, (existing) => ({
        threadId: input.threadId,
        filePath: loaded.relativePath,
        format: loaded.format,
        activeTab: input.activeTab ?? "canvas",
        ...(input.selectedNet && input.selectedNet.length > 0
          ? { selectedNet: input.selectedNet }
          : existing?.selectedNet && existing.filePath === loaded.relativePath
            ? { selectedNet: existing.selectedNet }
            : {}),
        ...(existing?.lastTrace !== undefined && existing.filePath === loaded.relativePath
          ? { lastTrace: existing.lastTrace }
          : {}),
        ...(existing?.lastValidation !== undefined && existing.filePath === loaded.relativePath
          ? { lastValidation: existing.lastValidation }
          : {}),
        ...(existing?.lastSimulation !== undefined && existing.filePath === loaded.relativePath
          ? { lastSimulation: existing.lastSimulation }
          : {}),
        openedAt: existing?.openedAt ?? now,
        updatedAt: now,
      }));
      return session!;
    });

    const closePanel = Effect.fn("ElectronicsService.closePanel")(function* (threadId: ThreadId) {
      yield* Ref.update(closeGenRef, (map) => {
        const next = new Map(map);
        next.set(threadId, (next.get(threadId) ?? 0) + 1);
        return next;
      });
      yield* Ref.update(sessionsRef, (map) => {
        const next = new Map(map);
        next.delete(threadId);
        return next;
      });
      yield* broadcast;
    });

    const getThreadSession = (threadId: ThreadId) =>
      Ref.get(sessionsRef).pipe(Effect.map((map) => map.get(threadId)));

    const subscribeState: Stream.Stream<ElectronicsServiceState> = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe BEFORE snapshotting so updates emitted during buildState are never missed.
        const subscription = yield* PubSub.subscribe(updates);
        const initial = yield* buildState;
        return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
      }),
    );

    const getToolchainStatus = Effect.fn("ElectronicsService.getToolchainStatus")(function* (
      refresh = false,
    ) {
      const status = yield* probeToolchain(refresh);
      if (refresh) yield* broadcast;
      return status;
    });

    return ElectronicsService.of({
      getState: buildState,
      subscribeState,
      getToolchainStatus,
      listFiles,
      inspect,
      tracePath,
      validate,
      simulate,
      openPanel,
      closePanel,
      getThreadSession,
    });
  }),
);
