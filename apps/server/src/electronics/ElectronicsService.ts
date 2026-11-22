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
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSettings from "../serverSettings.ts";
import { runBuiltinMnaSimulation } from "./mnaSolver.ts";
import { detectElectronicsFormat, parseElectronicsFile } from "./parsers.ts";
import { traceCircuitPath } from "./pathTracer.ts";
import {
  expandSpiceWorkspaceDeck,
  probeBinary,
  runKiCadExternalValidation,
  runNgspiceSimulation,
} from "./toolchain.ts";
import { assembleValidationReport, runBuiltinCircuitValidation } from "./validator.ts";

const MAX_CIRCUIT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DISCOVERY_DEPTH = 6;
const MAX_DISCOVERY_FILES = 200;
const MAX_DISCOVERY_ENTRIES = 5_000;

function isWithinRoot(pathApi: Path.Path, rootReal: string, candidate: string): boolean {
  const rel = pathApi.relative(rootReal, candidate);
  if (rel === "") return true;
  if (pathApi.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${pathApi.sep}`) && !rel.startsWith("../");
}

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
      options?: boolean | { readonly refresh?: boolean; readonly allowSpawn?: boolean },
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
      navigationGeneration?: number,
    ) => Effect.Effect<ElectronicsTracePathResult, ElectronicsError>;
    readonly validate: (
      input: ElectronicsValidateInput,
      threadId?: ThreadId,
      navigationGeneration?: number,
    ) => Effect.Effect<ElectronicsValidationReport, ElectronicsError>;
    readonly simulate: (
      input: ElectronicsSimulateInput,
      threadId?: ThreadId,
      navigationGeneration?: number,
    ) => Effect.Effect<ElectronicsSimulationResult, ElectronicsError>;
    readonly reserveNavigationToken: (threadId: ThreadId) => Effect.Effect<number>;
    readonly getNavigationGeneration: (threadId: ThreadId) => Effect.Effect<number>;
    readonly openPanel: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
      readonly navigationToken?: number | undefined;
    }) => Effect.Effect<ElectronicsThreadSession, ElectronicsError>;
    readonly openPanelWithModel: (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
      readonly navigationToken?: number | undefined;
    }) => Effect.Effect<
      { readonly session: ElectronicsThreadSession; readonly model: ElectronicsCircuitModel },
      ElectronicsError
    >;
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

    const sessionStoreRef = yield* Ref.make<{
      readonly sessions: ReadonlyMap<ThreadId, ElectronicsThreadSession>;
      readonly nav: ReadonlyMap<
        ThreadId,
        { readonly nextSeq: number; readonly committedSeq: number }
      >;
    }>({
      sessions: new Map(),
      nav: new Map(),
    });
    const lastUpdatedMsRef = yield* Ref.make<Map<ThreadId, number>>(new Map());
    const externalToolSemaphore = Semaphore.makeUnsafe(2);
    const toolchainCacheRef = yield* Ref.make<{
      readonly status: ElectronicsToolchainStatus;
      readonly kicadPath: string;
      readonly ngspicePath: string;
    } | null>(null);
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
      options: { readonly forceRefresh?: boolean; readonly allowSpawn?: boolean } = {},
    ) {
      const forceRefresh = options.forceRefresh ?? false;
      const allowSpawn = options.allowSpawn ?? true;
      const settings = yield* getSettings;
      const kicadPath = settings.electronicsKicadCliPath.trim();
      const ngspicePath = settings.electronicsNgspicePath.trim();
      const cached = yield* Ref.get(toolchainCacheRef);
      if (
        !forceRefresh &&
        cached !== null &&
        cached.status.enabled === settings.enableElectronicsWorkbench &&
        cached.status.allowExternalTools === settings.electronicsAllowExternalTools &&
        cached.status.agentAccessEnabled === settings.enableAgentElectronicsAccess &&
        cached.kicadPath === kicadPath &&
        cached.ngspicePath === ngspicePath
      ) {
        return cached.status;
      }
      if (!settings.electronicsAllowExternalTools) {
        const status: ElectronicsToolchainStatus = {
          enabled: settings.enableElectronicsWorkbench,
          allowExternalTools: false,
          agentAccessEnabled: settings.enableAgentElectronicsAccess,
          kicadCli: {
            name: "kicad-cli" as const,
            available: false,
            error: "External tools disabled in Settings → Electronics.",
          },
          ngspice: {
            name: "ngspice" as const,
            available: false,
            error: "External tools disabled in Settings → Electronics.",
          },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* Ref.set(toolchainCacheRef, { status, kicadPath, ngspicePath });
        return status;
      }
      if (!allowSpawn) {
        return {
          enabled: settings.enableElectronicsWorkbench,
          allowExternalTools: true,
          agentAccessEnabled: settings.enableAgentElectronicsAccess,
          kicadCli: {
            name: "kicad-cli" as const,
            available: false,
            error: "Not yet probed.",
          },
          ngspice: {
            name: "ngspice" as const,
            available: false,
            error: "Not yet probed.",
          },
          checkedAt: DateTime.formatIso(yield* DateTime.now),
        } satisfies ElectronicsToolchainStatus;
      }

      const [kicadCli, ngspice] = yield* externalToolSemaphore.withPermits(1)(
        Effect.all([
          probeBinary("kicad-cli", kicadPath).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
          probeBinary("ngspice", ngspicePath).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          ),
        ]),
      );

      const status: ElectronicsToolchainStatus = {
        enabled: settings.enableElectronicsWorkbench,
        allowExternalTools: settings.electronicsAllowExternalTools,
        agentAccessEnabled: settings.enableAgentElectronicsAccess,
        kicadCli,
        ngspice,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* Ref.set(toolchainCacheRef, { status, kicadPath, ngspicePath });
      return status;
    });

    const buildState = Effect.gen(function* () {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const toolchain = yield* probeToolchain({ forceRefresh: false, allowSpawn: false }).pipe(
        Effect.orElseSucceed((): ElectronicsToolchainStatus => ({
          enabled: true,
          allowExternalTools: false,
          agentAccessEnabled: true,
          kicadCli: { name: "kicad-cli", available: false },
          ngspice: { name: "ngspice", available: false },
          checkedAt: nowIso,
        })),
      );
      const sessions = Array.from((yield* Ref.get(sessionStoreRef)).sessions.values());
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
      const rootReal = yield* fs.realPath(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ElectronicsError({
              code: "invalid_path",
              message: "Workspace root could not be resolved.",
              cause,
            }),
        ),
      );
      const candidate = path.isAbsolute(requestedPath)
        ? path.resolve(requestedPath)
        : path.resolve(rootReal, requestedPath);

      if (!isWithinRoot(path, rootReal, candidate)) {
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
      const targetReal = yield* fs.realPath(candidate).pipe(
        Effect.mapError(
          (cause) =>
            new ElectronicsError({
              code: "invalid_path",
              message: `Unable to resolve "${requestedPath}".`,
              cause,
            }),
        ),
      );

      if (!isWithinRoot(path, rootReal, targetReal)) {
        return yield* new ElectronicsError({
          code: "invalid_path",
          message: `Path "${requestedPath}" escapes the workspace root.`,
        });
      }
      const relative = path.relative(rootReal, targetReal);

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
      const rootReal = yield* fs.realPath(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new ElectronicsError({
              code: "invalid_path",
              message: "Workspace root could not be resolved.",
              cause,
            }),
        ),
      );
      const found: ElectronicsWorkspaceFile[] = [];
      const visitedDirs = new Set<string>([rootReal]);
      let entriesVisited = 0;

      const walk = Effect.fn("ElectronicsService.walk")(function* (
        dir: string,
        depth: number,
      ): Effect.fn.Return<void> {
        if (
          depth > MAX_DISCOVERY_DEPTH ||
          found.length >= MAX_DISCOVERY_FILES ||
          entriesVisited >= MAX_DISCOVERY_ENTRIES
        ) {
          return;
        }
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        for (const entry of entries) {
          if (found.length >= MAX_DISCOVERY_FILES || entriesVisited >= MAX_DISCOVERY_ENTRIES) {
            break;
          }
          entriesVisited += 1;
          if (IGNORED_DIRECTORIES.has(entry)) continue;
          const fullPath = path.join(dir, entry);
          // Resolve canonical destination to reject symlinks escaping the workspace and prevent cycles.
          const realFullPath = yield* fs.realPath(fullPath).pipe(Effect.orElseSucceed(() => null));
          if (!realFullPath || !isWithinRoot(path, rootReal, realFullPath)) continue;
          const stat = yield* fs.stat(realFullPath).pipe(Effect.orElseSucceed(() => null));
          if (!stat) continue;
          if (stat.type === "Directory") {
            if (visitedDirs.has(realFullPath)) continue;
            visitedDirs.add(realFullPath);
            yield* walk(realFullPath, depth + 1);
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
      const toolchain = yield* probeToolchain({ forceRefresh: false, allowSpawn: false });
      return { files: found, toolchain } satisfies ElectronicsListFilesResult;
    });

    const reserveNavigationToken = (threadId: ThreadId) =>
      Ref.modify(sessionStoreRef, (state) => {
        const prev = state.nav.get(threadId) ?? { nextSeq: 0, committedSeq: 0 };
        const token = prev.nextSeq + 1;
        const nextNav = new Map(state.nav);
        nextNav.set(threadId, { nextSeq: token, committedSeq: prev.committedSeq });
        return [token, { sessions: state.sessions, nav: nextNav }] as const;
      });

    const getNavigationGeneration = (threadId: ThreadId) =>
      Ref.get(sessionStoreRef).pipe(
        Effect.map((state) => state.nav.get(threadId)?.committedSeq ?? 0),
      );

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
      updater: (existing: ElectronicsThreadSession | undefined) => ElectronicsThreadSession | null,
      expectedCommittedSeq?: number,
    ) {
      const committed = yield* Ref.modify(sessionStoreRef, (state) => {
        const nav = state.nav.get(threadId) ?? { nextSeq: 0, committedSeq: 0 };
        if (expectedCommittedSeq !== undefined && nav.committedSeq !== expectedCommittedSeq) {
          return [null, state] as const;
        }
        const updated = updater(state.sessions.get(threadId));
        if (updated === null) return [null, state] as const;
        const nextSessions = new Map(state.sessions);
        nextSessions.set(threadId, updated);
        return [updated, { sessions: nextSessions, nav: state.nav }] as const;
      });
      if (committed !== null) {
        yield* broadcast;
      }
      return committed;
    });

    const commitOpenSession = Effect.fn("ElectronicsService.commitOpenSession")(function* (
      threadId: ThreadId,
      token: number,
      updater: (existing: ElectronicsThreadSession | undefined) => ElectronicsThreadSession,
    ) {
      const committed = yield* Ref.modify(sessionStoreRef, (state) => {
        const nav = state.nav.get(threadId) ?? { nextSeq: 0, committedSeq: 0 };
        if (token <= nav.committedSeq) {
          return [null, state] as const;
        }
        const updated = updater(state.sessions.get(threadId));
        const nextSessions = new Map(state.sessions);
        nextSessions.set(threadId, updated);
        const nextNav = new Map(state.nav);
        nextNav.set(threadId, {
          nextSeq: Math.max(nav.nextSeq, token),
          committedSeq: token,
        });
        return [updated, { sessions: nextSessions, nav: nextNav }] as const;
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
      navigationGeneration?: number,
    ) {
      const startGen =
        navigationGeneration ??
        (threadId !== undefined ? yield* getNavigationGeneration(threadId) : undefined);
      yield* ensureEnabled;
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
          (existing) => {
            // Never overwrite an explicitly opened session for a different file with a cross-file result.
            if (
              existing !== undefined &&
              existing.panelOpenedAt !== undefined &&
              existing.filePath !== loaded.relativePath
            ) {
              return null;
            }
            return {
              threadId,
              filePath: loaded.relativePath,
              format: loaded.format,
              activeTab: "trace",
              ...(result.highlightedNets[0] !== undefined
                ? { selectedNet: result.highlightedNets[0] }
                : {}),
              lastTrace: result,
              ...(existing?.lastValidation !== undefined &&
              existing.filePath === loaded.relativePath
                ? { lastValidation: existing.lastValidation }
                : {}),
              ...(existing?.lastSimulation !== undefined &&
              existing.filePath === loaded.relativePath
                ? { lastSimulation: existing.lastSimulation }
                : {}),
              openedAt: existing?.openedAt ?? now,
              ...(existing?.panelOpenedAt !== undefined
                ? { panelOpenedAt: existing.panelOpenedAt }
                : {}),
              updatedAt: now,
            };
          },
          startGen,
        );
      }
      return result;
    });

    const validate = Effect.fn("ElectronicsService.validate")(function* (
      input: ElectronicsValidateInput,
      threadId?: ThreadId,
      navigationGeneration?: number,
    ) {
      const startGen =
        navigationGeneration ??
        (threadId !== undefined ? yield* getNavigationGeneration(threadId) : undefined);
      const settings = yield* ensureEnabled;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const builtin = runBuiltinCircuitValidation(loaded.model);
      const enginesUsed: ElectronicsValidationSource[] = ["builtin"];
      const notes = [...builtin.notes];
      const externalIssues = [];

      const wantExternal =
        (input.useExternalToolchain ?? true) && settings.electronicsAllowExternalTools;

      if (wantExternal && (loaded.format === "kicad_sch" || loaded.format === "kicad_pcb")) {
        const toolchain = yield* probeToolchain({ forceRefresh: false, allowSpawn: true });
        if (toolchain.kicadCli.available) {
          const ext = yield* externalToolSemaphore.withPermits(1)(
            runKiCadExternalValidation({
              absolutePath: loaded.absolutePath,
              format: loaded.format,
              ...(settings.electronicsKicadCliPath
                ? { kicadCliPath: settings.electronicsKicadCliPath }
                : {}),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            ),
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
          (existing) => {
            if (
              existing !== undefined &&
              existing.panelOpenedAt !== undefined &&
              existing.filePath !== loaded.relativePath
            ) {
              return null;
            }
            return {
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
              ...(existing?.lastSimulation !== undefined &&
              existing.filePath === loaded.relativePath
                ? { lastSimulation: existing.lastSimulation }
                : {}),
              openedAt: existing?.openedAt ?? now,
              ...(existing?.panelOpenedAt !== undefined
                ? { panelOpenedAt: existing.panelOpenedAt }
                : {}),
              updatedAt: now,
            };
          },
          startGen,
        );
      }

      return report;
    });

    const simulate = Effect.fn("ElectronicsService.simulate")(function* (
      input: ElectronicsSimulateInput,
      threadId?: ThreadId,
      navigationGeneration?: number,
    ) {
      const startGen =
        navigationGeneration ??
        (threadId !== undefined ? yield* getNavigationGeneration(threadId) : undefined);
      const settings = yield* ensureEnabled;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const kind = input.kind ?? "dc_op";

      let result: ElectronicsSimulationResult | null = null;
      let externalNote: string | undefined;
      const wantExternal =
        (input.useExternalToolchain ?? true) && settings.electronicsAllowExternalTools;

      if (wantExternal && loaded.format === "spice") {
        const toolchain = yield* probeToolchain({ forceRefresh: false, allowSpawn: true });
        if (toolchain.ngspice.available) {
          const outcome = yield* externalToolSemaphore.withPermits(1)(
            runNgspiceSimulation({
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
            ),
          );
          result = outcome.result;
          externalNote = outcome.rejectionNote;
        }
      }

      if (result === null) {
        let simModel = loaded.model;
        if (loaded.format === "spice" && /^\s*\.(include|inc|lib)\b/imu.test(loaded.content)) {
          const expanded = yield* expandSpiceWorkspaceDeck({
            spiceSource: loaded.content,
            workspaceRoot: input.cwd,
            sourceFilePath: loaded.absolutePath,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          if (!expanded.ok) {
            return yield* new ElectronicsError({
              code: "simulation_failed",
              message: `Cannot simulate SPICE deck with unresolved includes: ${expanded.reason}`,
            });
          }
          if (expanded.includedCount > 0) {
            const expandedText = `* expanded\n${expanded.lines.join("\n")}\n.end\n`;
            simModel = yield* Effect.try({
              try: () => parseElectronicsFile(loaded.relativePath, expandedText),
              catch: (cause) =>
                new ElectronicsError({
                  code: "simulation_failed",
                  message:
                    cause instanceof Error ? cause.message : "Failed to parse expanded SPICE deck.",
                  cause,
                }),
            });
          }
        }
        const builtinResult = yield* Effect.try({
          try: () =>
            runBuiltinMnaSimulation(simModel, {
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
        const hasSkippedNonlinear = builtinResult.notes.some((n) =>
          n.startsWith("Skipped non-linear/unparsed elements"),
        );
        if (externalNote !== undefined && hasSkippedNonlinear) {
          return yield* new ElectronicsError({
            code: "simulation_failed",
            message: `External ngspice failed (${externalNote}) and circuit contains nonlinear elements unsupported by the built-in linear MNA solver.`,
          });
        }
        result =
          externalNote !== undefined
            ? {
                ...builtinResult,
                notes: [`External ngspice skipped: ${externalNote}`, ...builtinResult.notes],
              }
            : builtinResult;
      }

      if (threadId !== undefined) {
        const now = yield* nextMonotonicIso(threadId);
        yield* updateThreadSession(
          threadId,
          (existing) => {
            if (
              existing !== undefined &&
              existing.panelOpenedAt !== undefined &&
              existing.filePath !== loaded.relativePath
            ) {
              return null;
            }
            return {
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
              ...(existing?.lastValidation !== undefined &&
              existing.filePath === loaded.relativePath
                ? { lastValidation: existing.lastValidation }
                : {}),
              lastSimulation: result,
              openedAt: existing?.openedAt ?? now,
              ...(existing?.panelOpenedAt !== undefined
                ? { panelOpenedAt: existing.panelOpenedAt }
                : {}),
              updatedAt: now,
            };
          },
          startGen,
        );
      }

      return result;
    });

    const openPanelWithModel = Effect.fn("ElectronicsService.openPanel")(function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
      readonly navigationToken?: number | undefined;
    }) {
      // Atomically reserve a monotonic navigation token BEFORE any async settings/file I/O
      // (or use one already reserved by the caller before workspace lookup) so closePanel or a
      // newer openPanel always wins while failed opens never invalidate concurrent valid work.
      const myToken = input.navigationToken ?? (yield* reserveNavigationToken(input.threadId));
      yield* ensureEnabled;
      const loaded = yield* loadAndParse(input.cwd, input.filePath);
      const now = yield* nextMonotonicIso(input.threadId);
      const nextSession = (
        existing: ElectronicsThreadSession | undefined,
      ): ElectronicsThreadSession => ({
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
        panelOpenedAt: now,
        updatedAt: now,
      });
      const committed = yield* commitOpenSession(input.threadId, myToken, nextSession);
      return { session: committed ?? nextSession(undefined), model: loaded.model };
    });

    const openPanel = (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly filePath: string;
      readonly activeTab?: ElectronicsPanelTab | undefined;
      readonly selectedNet?: string | undefined;
      readonly navigationToken?: number | undefined;
    }) => openPanelWithModel(input).pipe(Effect.map((res) => res.session));

    const closePanel = Effect.fn("ElectronicsService.closePanel")(function* (threadId: ThreadId) {
      yield* Ref.update(sessionStoreRef, (state) => {
        const prev = state.nav.get(threadId) ?? { nextSeq: 0, committedSeq: 0 };
        const closeSeq = prev.nextSeq + 1;
        const nextNav = new Map(state.nav);
        nextNav.set(threadId, { nextSeq: closeSeq, committedSeq: closeSeq });
        const nextSessions = new Map(state.sessions);
        nextSessions.delete(threadId);
        return { sessions: nextSessions, nav: nextNav };
      });
      yield* broadcast;
    });

    const getThreadSession = (threadId: ThreadId) =>
      Ref.get(sessionStoreRef).pipe(Effect.map((state) => state.sessions.get(threadId)));

    const subscribeState: Stream.Stream<ElectronicsServiceState> = Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe BEFORE snapshotting so updates emitted during buildState are never missed.
        const subscription = yield* PubSub.subscribe(updates);
        const initial = yield* buildState;
        return Stream.concat(Stream.make(initial), Stream.fromSubscription(subscription));
      }),
    );

    const getToolchainStatus = Effect.fn("ElectronicsService.getToolchainStatus")(function* (
      options: boolean | { readonly refresh?: boolean; readonly allowSpawn?: boolean } = false,
    ) {
      const refresh = typeof options === "boolean" ? options : (options.refresh ?? false);
      const allowSpawn = typeof options === "boolean" ? true : (options.allowSpawn ?? true);
      const status = yield* probeToolchain({ forceRefresh: refresh, allowSpawn });
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
      reserveNavigationToken,
      getNavigationGeneration,
      openPanel,
      openPanelWithModel,
      closePanel,
      getThreadSession,
    });
  }),
);
