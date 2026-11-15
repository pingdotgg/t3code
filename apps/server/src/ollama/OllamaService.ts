// @effect-diagnostics nodeBuiltinImport:off - Effect has no zstd stream, incremental digest, or piped child stdin.
import {
  OLLAMA_AGENT_INSTANCE_ID,
  OllamaError,
  ProviderInstanceId,
  type OllamaGpu,
  type OllamaHardware,
  type OllamaInstallEvent,
  type OllamaInstalledModel,
  type OllamaOverview,
  type OllamaPullEvent,
  type OllamaStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeStreamPromises from "node:stream/promises";
import * as NodeZlib from "node:zlib";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import { ollamaModelSupportsAgents } from "@t3tools/shared/ollamaCatalog";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildOllamaAgentInstance,
  ollamaAgentCodexBinaryPath,
  ollamaAgentInstanceIsCurrent,
} from "./OllamaAgentInstance.ts";
import {
  EMPTY_PULL_PROGRESS,
  findSha256,
  isOllamaAgentVariant,
  OLLAMA_AGENT_CONTEXT_TOKENS,
  ollamaAgentContextTokens,
  ollamaAgentVariantName,
  ollamaExecutableCandidates,
  ollamaListenAddress,
  ollamaReleaseAsset,
  parseNvidiaSmiGpus,
  reduceOllamaPullLine,
  resolveOllamaBaseUrl,
} from "./ollamaRuntime.ts";

const RELEASES_API = "https://api.github.com/repos/ollama/ollama/releases/latest";
const RELEASE_DOWNLOAD = "https://github.com/ollama/ollama/releases/download";
const PROBE_TIMEOUT = Duration.seconds(2);
const DOWNLOAD_TIMEOUT = Duration.hours(2);

const VersionResponse = Schema.Struct({ version: Schema.String });
const TagsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      size: Schema.Number,
      modified_at: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Struct({
          family: Schema.optional(Schema.String),
          parameter_size: Schema.optional(Schema.String),
          quantization_level: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});
const ShowResponse = Schema.Struct({
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  model_info: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const LatestRelease = Schema.Struct({ tag_name: Schema.String });
const decodeVersion = Schema.decodeUnknownEffect(VersionResponse);
const decodeTags = Schema.decodeUnknownEffect(TagsResponse);
const decodeShow = Schema.decodeUnknownEffect(ShowResponse);
const decodeLatestRelease = Schema.decodeUnknownEffect(LatestRelease);

const ollamaError = (message: string) => new OllamaError({ message });

export class OllamaService extends Context.Service<
  OllamaService,
  {
    readonly overview: Effect.Effect<OllamaOverview, OllamaError>;
    readonly installWithProgress: (
      report: (event: OllamaInstallEvent) => Effect.Effect<void>,
    ) => Effect.Effect<OllamaStatus, OllamaError>;
    readonly start: Effect.Effect<OllamaStatus, OllamaError>;
    readonly pullWithProgress: (
      model: string,
      report: (event: OllamaPullEvent) => Effect.Effect<void>,
    ) => Effect.Effect<void, OllamaError>;
    readonly deleteModel: (model: string) => Effect.Effect<void, OllamaError>;
    readonly setAgentIntegration: (enabled: boolean) => Effect.Effect<OllamaStatus, OllamaError>;
  }
>()("t3/ollama/OllamaService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const hostEnvironment = yield* HostProcess.Environment;

  const baseUrl = resolveOllamaBaseUrl(hostEnvironment.OLLAMA_HOST);
  const asset = ollamaReleaseAsset(platform, arch);
  const runtimeDir = path.join(config.baseDir, "runtimes", "ollama");
  const currentDir = path.join(runtimeDir, "current");
  const versionFile = path.join(runtimeDir, "version");
  const codexHome = path.join(config.baseDir, "codex-ollama");
  const instanceId = ProviderInstanceId.make(OLLAMA_AGENT_INSTANCE_ID);

  const serveScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(serveScope, Exit.void));
  const managedRunning = yield* Ref.make(false);
  const installLock = yield* Semaphore.make(1);

  const apiJson = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.scoped,
    );

  const probeVersion = apiJson(HttpClientRequest.get(`${baseUrl}/api/version`)).pipe(
    Effect.flatMap(decodeVersion),
    Effect.map((response) => Option.some(response.version)),
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const managedExecutable = Effect.gen(function* () {
    for (const candidate of ollamaExecutableCandidates(platform)) {
      const full = path.join(currentDir, candidate);
      if (yield* fs.exists(full).pipe(Effect.orElseSucceed(() => false))) return Option.some(full);
    }
    return Option.none<string>();
  });

  const managedVersion = fs.readFileString(versionFile).pipe(
    Effect.map((value) => Option.some(value.trim())),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  const agentIntegrationEnabled = settings.getSettings.pipe(
    Effect.map((current) => Object.hasOwn(current.providerInstances, instanceId)),
    Effect.orElseSucceed(() => false),
  );

  const status: Effect.Effect<OllamaStatus> = Effect.gen(function* () {
    const version = yield* probeVersion;
    const executable = yield* managedExecutable;
    const running = yield* Ref.get(managedRunning);
    return {
      baseUrl,
      reachable: Option.isSome(version),
      version: Option.getOrNull(version),
      runtime: running ? "managed" : Option.isSome(version) ? "external" : "none",
      managedInstalled: Option.isSome(executable),
      managedVersion: Option.getOrNull(yield* managedVersion),
      canInstall: asset !== null,
      agentIntegrationEnabled: yield* agentIntegrationEnabled,
    } satisfies OllamaStatus;
  });

  const readGpus = Effect.gen(function* () {
    if (platform === "darwin" && arch === "arm64") {
      return [{ name: "Apple silicon GPU", vendor: "apple", memoryBytes: null }] as const;
    }
    const nvidia = yield* spawner
      .string(
        ChildProcess.make(
          "nvidia-smi",
          ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
          { stdin: "ignore", stderr: "ignore" },
        ),
      )
      .pipe(
        Effect.map(parseNvidiaSmiGpus),
        Effect.timeout(Duration.seconds(5)),
        Effect.orElseSucceed((): ReadonlyArray<OllamaGpu> => []),
      );
    if (nvidia.length > 0 || platform !== "linux") return nvidia;
    // AMD exposes VRAM size through sysfs on Linux.
    const cards = yield* fs.readDirectory("/sys/class/drm").pipe(Effect.orElseSucceed(() => []));
    const amd: Array<OllamaGpu> = [];
    for (const card of cards.filter((name) => /^card\d+$/.test(name))) {
      const device = path.join("/sys/class/drm", card, "device");
      const vendor = yield* fs
        .readFileString(path.join(device, "vendor"))
        .pipe(Effect.orElseSucceed(() => ""));
      if (vendor.trim() !== "0x1002") continue;
      const vram = yield* fs
        .readFileString(path.join(device, "mem_info_vram_total"))
        .pipe(Effect.orElseSucceed(() => ""));
      const bytes = Number(vram.trim());
      amd.push({ name: "AMD GPU", vendor: "amd", memoryBytes: bytes > 0 ? bytes : null });
    }
    return amd;
  });

  const hardware: Effect.Effect<OllamaHardware> = Effect.gen(function* () {
    const cpus = NodeOS.cpus();
    return {
      platform,
      arch,
      totalMemoryBytes: NodeOS.totalmem(),
      freeMemoryBytes: NodeOS.freemem(),
      cpuCount: cpus.length,
      cpuModel: cpus[0]?.model.trim() ?? "Unknown CPU",
      gpus: yield* readGpus,
      unifiedMemory: platform === "darwin" && arch === "arm64",
    };
  });

  const listModels: Effect.Effect<ReadonlyArray<OllamaInstalledModel>, OllamaError> = apiJson(
    HttpClientRequest.get(`${baseUrl}/api/tags`),
  ).pipe(
    Effect.flatMap(decodeTags),
    Effect.flatMap((tags) =>
      Effect.forEach(
        // Agent variants are an implementation detail of their base model.
        tags.models.filter((model) => !isOllamaAgentVariant(model.name)),
        (model) =>
          HttpClientRequest.post(`${baseUrl}/api/show`).pipe(
            HttpClientRequest.bodyJson({ model: model.name }),
            Effect.flatMap(apiJson),
            Effect.flatMap(decodeShow),
            Effect.orElseSucceed(() => ({ capabilities: undefined, model_info: undefined })),
            Effect.map((show): OllamaInstalledModel => {
              const contextKey = Object.keys(show.model_info ?? {}).find((key) =>
                key.endsWith(".context_length"),
              );
              const context = contextKey ? show.model_info?.[contextKey] : undefined;
              return {
                name: model.name,
                sizeBytes: model.size,
                parameterSize: model.details?.parameter_size ?? null,
                quantization: model.details?.quantization_level ?? null,
                family: model.details?.family ?? null,
                contextLength: typeof context === "number" ? context : null,
                capabilities: show.capabilities ?? [],
                modifiedAt: model.modified_at ?? null,
              };
            }),
          ),
        { concurrency: 4 },
      ),
    ),
    Effect.mapError(() => ollamaError(`Could not list models from Ollama at ${baseUrl}.`)),
  );

  /** Keeps the agent instance's model list equal to the tool-capable models Ollama has. */
  // Codex refuses to start when CODEX_HOME does not exist.
  const ensureCodexHome = fs.makeDirectory(codexHome, { recursive: true });

  /** Creates the large-context variant agents run. It reuses the base model's weights. */
  const ensureAgentVariants = Effect.fn("OllamaService.ensureAgentVariants")(function* (
    models: ReadonlyArray<OllamaInstalledModel>,
  ) {
    const existing = yield* apiJson(HttpClientRequest.get(`${baseUrl}/api/tags`)).pipe(
      Effect.flatMap(decodeTags),
      Effect.map((tags) => new Set(tags.models.map((model) => model.name))),
      Effect.orElseSucceed(() => new Set<string>()),
    );
    for (const model of models.filter(ollamaModelSupportsAgents)) {
      const variant = ollamaAgentVariantName(model.name);
      if (existing.has(variant) || existing.has(`${variant}:latest`)) continue;
      yield* HttpClientRequest.post(`${baseUrl}/api/create`).pipe(
        HttpClientRequest.bodyJson({
          model: variant,
          from: model.name,
          parameters: { num_ctx: ollamaAgentContextTokens(model.contextLength) },
          stream: false,
        }),
        Effect.flatMap(apiJson),
        Effect.ignoreCause({ log: true }),
      );
    }
  });

  const syncAgentInstance = Effect.fn("OllamaService.syncAgentInstance")(
    function* (models: ReadonlyArray<OllamaInstalledModel>) {
      const current = yield* settings.getSettings;
      if (!Object.hasOwn(current.providerInstances, instanceId)) return;
      yield* ensureCodexHome;
      yield* ensureAgentVariants(models);
      const stored = current.providerInstances[instanceId];
      const next = buildOllamaAgentInstance({
        baseUrl,
        codexHome,
        codexBinaryPath: ollamaAgentCodexBinaryPath(stored),
        models,
      });
      if (ollamaAgentInstanceIsCurrent(stored, next)) return;
      yield* settings.updateProviderInstance({ operation: "upsert", instanceId, instance: next });
    },
    Effect.ignoreCause({ log: true }),
  );

  const overview = Effect.gen(function* () {
    const currentStatus = yield* status;
    const models = currentStatus.reachable ? yield* listModels : [];
    if (currentStatus.reachable && currentStatus.agentIntegrationEnabled) {
      yield* syncAgentInstance(models);
    }
    return { status: currentStatus, hardware: yield* hardware, models } satisfies OllamaOverview;
  }).pipe(Effect.withSpan("OllamaService.overview"));

  const serve = Effect.fn("OllamaService.serve")(
    function* (executable: string) {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, ["serve"], {
          env: {
            OLLAMA_HOST: ollamaListenAddress(baseUrl),
            // Chats outside agent variants also get a context that fits real work.
            OLLAMA_CONTEXT_LENGTH:
              hostEnvironment.OLLAMA_CONTEXT_LENGTH ?? String(OLLAMA_AGENT_CONTEXT_TOKENS),
          },
          extendEnv: true,
          stdin: "ignore",
        }),
      );
      yield* Ref.set(managedRunning, true);
      yield* Effect.all([Stream.runDrain(child.stdout), Stream.runDrain(child.stderr)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkScoped);
      yield* child.exitCode;
    },
    Effect.scoped,
    Effect.ensuring(Ref.set(managedRunning, false)),
    Effect.ignoreCause({ log: true }),
  );

  const awaitReachable = probeVersion.pipe(
    Effect.flatMap((version) =>
      Option.isSome(version) ? Effect.void : Effect.fail(ollamaError("Ollama did not start.")),
    ),
    Effect.retry({ schedule: Schedule.spaced(Duration.millis(400)), times: 75 }),
  );

  const start = Effect.gen(function* () {
    if (Option.isSome(yield* probeVersion)) return yield* status;
    const executable = yield* managedExecutable;
    if (Option.isNone(executable)) {
      return yield* ollamaError(
        "Ollama is not installed. Install it from Settings → Local models.",
      );
    }
    yield* serve(executable.value).pipe(Effect.forkIn(serveScope));
    yield* awaitReachable;
    return yield* status;
  }).pipe(Effect.withSpan("OllamaService.start"));

  const download = Effect.fn("OllamaService.download")(
    function* (
      url: string,
      destination: string,
      report: (completed: number, total: number | null) => Effect.Effect<void>,
    ) {
      const response = yield* http
        .execute(HttpClientRequest.get(url))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const lengthHeader = Number(response.headers["content-length"]);
      const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;
      const hash = NodeCrypto.createHash("sha256");
      let completed = 0;
      let lastReported = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) =>
          Effect.suspend(() => {
            hash.update(chunk);
            completed += chunk.byteLength;
            if (completed - lastReported < 8_000_000 && completed !== total) return Effect.void;
            lastReported = completed;
            return report(completed, total);
          }),
        ),
        Stream.run(fs.sink(destination)),
      );
      return hash.digest("hex");
    },
    Effect.scoped,
    Effect.timeout(DOWNLOAD_TIMEOUT),
  );

  const extract = (archive: string, format: "tar.zst" | "tgz" | "zip", destination: string) =>
    Effect.tryPromise({
      try: async () => {
        if (format === "tar.zst") {
          // Not every tar understands zstd, so Node decompresses and tar only unpacks.
          const tar = NodeChildProcess.spawn("tar", ["-x", "-f", "-", "-C", destination], {
            stdio: ["pipe", "ignore", "pipe"],
          });
          const exited = new Promise<number | null>((resolve, reject) => {
            tar.once("error", reject);
            tar.once("close", resolve);
          });
          await NodeStreamPromises.pipeline(
            NodeFS.createReadStream(archive),
            NodeZlib.createZstdDecompress(),
            tar.stdin,
          );
          if ((await exited) !== 0) throw new Error("tar failed");
          return;
        }
        // Windows 10+ ships bsdtar, which also reads zip archives.
        const args = format === "tgz" ? ["-x", "-z", "-f", archive] : ["-x", "-f", archive];
        await new Promise<void>((resolve, reject) => {
          const tar = NodeChildProcess.spawn("tar", [...args, "-C", destination], {
            stdio: "ignore",
          });
          tar.once("error", reject);
          tar.once("close", (code) => (code === 0 ? resolve() : reject(new Error("tar failed"))));
        });
      },
      catch: () => ollamaError("Could not unpack the Ollama download."),
    });

  const installWithProgress = Effect.fn("OllamaService.install")(function* (
    report: (event: OllamaInstallEvent) => Effect.Effect<void>,
  ) {
    if (asset === null) {
      return yield* ollamaError(
        `Continuum cannot install Ollama on ${platform}-${arch}. Install it from ollama.com.`,
      );
    }
    const release = yield* apiJson(
      HttpClientRequest.get(RELEASES_API).pipe(
        HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
      ),
    ).pipe(
      Effect.flatMap(decodeLatestRelease),
      Effect.mapError(() => ollamaError("Could not look up the latest Ollama release.")),
    );
    const tag = release.tag_name;
    const sums = yield* http
      .execute(HttpClientRequest.get(`${RELEASE_DOWNLOAD}/${tag}/sha256sum.txt`))
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.text),
        Effect.scoped,
        Effect.mapError(() => ollamaError("Could not download Ollama's checksums.")),
      );
    const expected = findSha256(sums, asset.name);
    if (expected === null) {
      return yield* ollamaError(`Ollama ${tag} does not list a checksum for ${asset.name}.`);
    }

    yield* fs.makeDirectory(runtimeDir, { recursive: true }).pipe(Effect.orDie);
    const staging = path.join(runtimeDir, `staging-${tag}`);
    yield* fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fs.makeDirectory(staging, { recursive: true }).pipe(Effect.orDie);
    const archive = path.join(runtimeDir, asset.name);
    yield* report({ type: "progress", stage: "downloading", completedBytes: 0, totalBytes: null });
    const actual = yield* download(
      `${RELEASE_DOWNLOAD}/${tag}/${asset.name}`,
      archive,
      (completedBytes, totalBytes) =>
        report({ type: "progress", stage: "downloading", completedBytes, totalBytes }),
    ).pipe(
      Effect.mapError(() =>
        ollamaError("Could not download Ollama. Check your connection and try again."),
      ),
    );
    if (actual !== expected) {
      yield* fs.remove(archive).pipe(Effect.ignore);
      return yield* ollamaError("The Ollama download failed its checksum. Nothing was installed.");
    }

    yield* report({
      type: "progress",
      stage: "extracting",
      completedBytes: null,
      totalBytes: null,
    });
    yield* extract(archive, asset.format, staging);
    yield* fs.remove(archive).pipe(Effect.ignore);
    yield* fs.remove(currentDir, { recursive: true, force: true }).pipe(Effect.ignore);
    yield* fs
      .rename(staging, currentDir)
      .pipe(Effect.mapError(() => ollamaError("Could not move Ollama into place.")));
    yield* fs.writeFileString(versionFile, tag).pipe(Effect.ignore);
    if (Option.isNone(yield* managedExecutable)) {
      return yield* ollamaError("The Ollama download did not contain the ollama program.");
    }

    yield* report({ type: "progress", stage: "starting", completedBytes: null, totalBytes: null });
    return yield* start;
  }, installLock.withPermits(1));

  const pullWithProgress = Effect.fn("OllamaService.pull")(function* (
    model: string,
    report: (event: OllamaPullEvent) => Effect.Effect<void>,
  ) {
    const request = yield* HttpClientRequest.post(`${baseUrl}/api/pull`).pipe(
      HttpClientRequest.bodyJson({ model, stream: true }),
      Effect.mapError(() => ollamaError("Could not prepare the download request.")),
    );
    const response = yield* http.execute(request).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(() =>
        ollamaError(`Could not reach Ollama at ${baseUrl}. Start Ollama and try again.`),
      ),
    );
    const progress = yield* Ref.make(EMPTY_PULL_PROGRESS);
    yield* response.stream.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.mapError(() => ollamaError("The model download was interrupted.")),
      Stream.runForEach((line) =>
        Effect.gen(function* () {
          const step = reduceOllamaPullLine(yield* Ref.get(progress), line);
          if (step === null) return;
          if (step.type === "error") return yield* ollamaError(step.message);
          yield* Ref.set(progress, step.progress);
          yield* report(step.event);
        }),
      ),
    );
    yield* report({ type: "complete", model });
    const models = yield* listModels.pipe(Effect.orElseSucceed(() => []));
    yield* syncAgentInstance(models);
  }, Effect.scoped);

  const deleteFromOllama = Effect.fn("OllamaService.deleteFromOllama")(function* (model: string) {
    const request = yield* HttpClientRequest.make("DELETE")(`${baseUrl}/api/delete`).pipe(
      HttpClientRequest.bodyJson({ model }),
    );
    yield* http
      .execute(request)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.scoped);
  });

  const deleteModel = Effect.fn("OllamaService.deleteModel")(function* (model: string) {
    yield* deleteFromOllama(ollamaAgentVariantName(model)).pipe(Effect.ignore);
    yield* deleteFromOllama(model).pipe(
      Effect.mapError(() => ollamaError(`Could not delete ${model}.`)),
    );
    const models = yield* listModels.pipe(Effect.orElseSucceed(() => []));
    yield* syncAgentInstance(models);
  });

  /** A compatible Codex on PATH, or the pinned runtime Continuum downloads for it. */
  const ensureCodex = Effect.gen(function* () {
    const existing = yield* codexInstallation.resolve().pipe(Effect.option);
    if (Option.isSome(existing)) return existing.value;
    yield* codexInstallation.start.pipe(
      Effect.mapError((error) => ollamaError(`Could not install Codex: ${error.message}`)),
    );
    const settled = yield* codexInstallation.changes.pipe(
      Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
      Stream.runHead,
      Effect.timeout(Duration.minutes(15)),
      Effect.mapError(() => ollamaError("Installing Codex took too long.")),
    );
    if (Option.isSome(settled) && settled.value.phase !== "succeeded") {
      return yield* ollamaError(settled.value.message ?? "Codex could not be installed.");
    }
    return yield* codexInstallation
      .resolve()
      .pipe(Effect.mapError((error) => ollamaError(`Codex is not ready: ${error.message}`)));
  });

  const setAgentIntegration = Effect.fn("OllamaService.setAgentIntegration")(function* (
    enabled: boolean,
  ) {
    if (enabled) {
      const codex = yield* ensureCodex;
      yield* ensureCodexHome.pipe(
        Effect.mapError(() => ollamaError("Could not create the local agent's Codex folder.")),
      );
      const models = yield* listModels.pipe(Effect.orElseSucceed(() => []));
      yield* ensureAgentVariants(models);
      yield* settings
        .updateProviderInstance({
          operation: "upsert",
          instanceId,
          instance: buildOllamaAgentInstance({
            baseUrl,
            codexHome,
            codexBinaryPath: codex.source === "managed" ? codex.executablePath : "",
            models,
          }),
        })
        .pipe(Effect.mapError(() => ollamaError("Could not save the Ollama agent settings.")));
    } else {
      const current = yield* settings.getSettings.pipe(
        Effect.mapError(() => ollamaError("Could not read settings.")),
      );
      if (Object.hasOwn(current.providerInstances, instanceId)) {
        yield* settings
          .updateProviderInstance({ operation: "remove", instanceId })
          .pipe(Effect.mapError(() => ollamaError("Could not remove the Ollama agent.")));
      }
    }
    return yield* status;
  });

  // A runtime Continuum installed starts with the server, so local agents keep working after a restart.
  yield* Effect.gen(function* () {
    if (Option.isSome(yield* probeVersion)) return;
    const executable = yield* managedExecutable;
    if (Option.isSome(executable)) yield* serve(executable.value);
  }).pipe(Effect.forkIn(serveScope));

  return OllamaService.of({
    overview,
    installWithProgress,
    start,
    pullWithProgress,
    deleteModel,
    setAgentIntegration,
  });
});

export const layer = Layer.effect(OllamaService, make);
