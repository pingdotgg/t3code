// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  ExtensionError,
  type ExtensionHostConnection,
  type ExtensionInstallInput,
  type ExtensionsState,
  type InstalledExtension,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Yauzl from "yauzl";
import { HostProcessPlatform, HostProcessArchitecture } from "@t3tools/shared/hostProcess";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  openVsxDownload,
  openVsxSha256,
  openVsxUrl,
  parseInstalledExtension,
  rehAsset,
} from "./extensionMetadata.ts";

const BASE_PATH = "/api/vscode";
const MAX_VSIX_BYTES = 512 * 1024 * 1024;
const error = (operation: ExtensionError["operation"], detail: string, cause?: unknown) => {
  const failure = new ExtensionError({ operation, detail });
  if (cause !== undefined) Object.defineProperty(failure, "cause", { value: cause });
  return failure;
};
const isExtensionError = Schema.is(ExtensionError);
const isProduct = Schema.is(Schema.Struct({ commit: Schema.String, quality: Schema.String }));

export const parseProduct = (text: string) =>
  Effect.try({
    try: () => {
      const product: unknown = JSON.parse(text);
      if (!isProduct(product)) throw new Error("Invalid VSCodium product.json.");
      return product;
    },
    catch: (cause) => error("host", "Could not parse VSCodium product.json.", cause),
  });

export const downloadRehArchive = (
  asset: NonNullable<ReturnType<typeof rehAsset>>,
  archive: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const fs = yield* FileSystem.FileSystem;
    const response = yield* http
      .execute(HttpClientRequest.get(asset.url))
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    let bytes = 0;
    const digest = NodeCrypto.createHash("sha256");
    yield* response.stream.pipe(
      Stream.tap((chunk) =>
        Effect.sync(() => {
          bytes += chunk.byteLength;
          digest.update(chunk);
        }),
      ),
      Stream.takeWhile(() => bytes <= 256 * 1024 * 1024),
      Stream.run(fs.sink(archive, { flag: "wx", mode: 0o600 })),
    );
    if (bytes > 256 * 1024 * 1024) return yield* error("host", "The REH archive is too large.");
    if (digest.digest("hex") !== asset.sha256)
      return yield* error("host", "The REH archive did not match its pinned SHA-256.");
  });

const readVsixId = (file: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        Yauzl.open(
          file,
          { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
          (cause, zip) => {
            if (cause || !zip) return reject(cause ?? new Error("Could not open VSIX."));
            zip.on("error", reject);
            zip.on("end", () => reject(new Error("VSIX has no extension/package.json.")));
            zip.on("entry", (entry) => {
              if (entry.fileName !== "extension/package.json") return zip.readEntry();
              if (entry.uncompressedSize > 1024 * 1024) {
                zip.close();
                return reject(new Error("VSIX manifest is too large."));
              }
              zip.openReadStream(entry, (streamError, stream) => {
                if (streamError || !stream)
                  return reject(streamError ?? new Error("Could not read VSIX manifest."));
                const chunks: Buffer[] = [];
                stream.on("data", (chunk: Buffer) => chunks.push(chunk));
                stream.on("error", reject);
                stream.on("end", () => {
                  try {
                    const manifest = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
                      publisher?: string;
                      name?: string;
                    };
                    if (!manifest.publisher || !manifest.name)
                      throw new Error("VSIX manifest has no extension ID.");
                    resolve(`${manifest.publisher}.${manifest.name}`);
                  } catch (error) {
                    reject(error);
                  }
                  zip.close();
                });
              });
            });
            zip.readEntry();
          },
        );
      }),
    catch: (cause) => error("install", "Could not read the VSIX manifest.", cause),
  });

interface ExtensionHostService {
  readonly subscribe: Stream.Stream<ExtensionsState, ExtensionError>;
  readonly connect: Effect.Effect<Omit<ExtensionHostConnection, "wsTicket">, ExtensionError>;
  readonly port: Effect.Effect<number, ExtensionError>;
  readonly install: (
    input: ExtensionInstallInput,
  ) => Effect.Effect<InstalledExtension, ExtensionError>;
  readonly uninstall: (id: string) => Effect.Effect<void, ExtensionError>;
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void, ExtensionError>;
  readonly iconPath: (id: string, relative?: string) => Effect.Effect<string | null>;
}

export class ExtensionHost extends Context.Service<ExtensionHost, ExtensionHostService>()(
  "t3/extensions/ExtensionHost",
) {
  static readonly layer = Layer.effect(
    ExtensionHost,
    Effect.suspend(() => makeExtensionHost),
  );
}

const makeExtensionHost = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const runner = yield* ProcessRunner.make();
  const serviceScope = yield* Effect.scope;
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  const base = config.vscodeDir;
  const serverDir = NodePath.join(base, "server");
  const extensionsDir = NodePath.join(base, "extensions");
  const userDir = NodePath.join(base, "user-data");
  const dataDir = NodePath.join(base, "server-data");
  const disabledPath = NodePath.join(base, "disabled.json");
  const executable = NodePath.join(serverDir, platform === "win32" ? "node.exe" : "node");
  const entryPoint = NodePath.join(serverDir, "out", "server-main.js");
  const asset = rehAsset(platform, arch);
  const state = yield* SubscriptionRef.make<ExtensionsState>({
    host: asset ? "notInstalled" : "unsupported",
    hostMessage: asset ? null : "VSCodium REH is not available for this platform.",
    extensions: [],
  });
  const lock = yield* Semaphore.make(1);
  let started = false;
  let active: { port: number; token: string; commit: string; quality: string } | null = null;
  let activeChild: ChildProcessSpawner.ChildProcessHandle | null = null;
  let restarting = false;
  let disabled = new Set<string>();
  yield* Effect.tryPromise({
    try: async () => {
      try {
        const saved: unknown = JSON.parse(await NodeFSP.readFile(disabledPath, "utf8"));
        if (!Array.isArray(saved) || !saved.every((id) => typeof id === "string")) {
          throw new Error("Invalid disabled extension list.");
        }
        disabled = new Set(saved.map((id) => id.toLowerCase()));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
    },
    catch: (cause) => error("list", "Could not read extension settings.", cause),
  });

  const refresh = Effect.gen(function* () {
    const extensions = yield* Effect.tryPromise({
      try: async () => {
        const result: InstalledExtension[] = [];
        for (const entry of await NodeFSP.readdir(extensionsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const directory = NodePath.join(extensionsDir, entry.name);
          try {
            const manifest = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
            );
            const nls = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "package.nls.json"), "utf8").catch(
                () => "{}",
              ),
            );
            const parsed = parseInstalledExtension(
              manifest,
              nls,
              !disabled.has(`${manifest.publisher}.${manifest.name}`.toLowerCase()),
            );
            if (parsed) result.push(parsed);
          } catch {
            continue;
          }
        }
        return result.sort((a, b) => a.id.localeCompare(b.id));
      },
      catch: (cause) => error("list", "Could not read installed extensions.", cause),
    });
    yield* SubscriptionRef.update(state, (previous) => ({ ...previous, extensions }));
    return extensions;
  });

  const setHost = (host: ExtensionsState["host"], hostMessage: string | null = null) =>
    SubscriptionRef.update(state, (previous) => ({ ...previous, host, hostMessage }));

  const runCli = (args: string[], operation: ExtensionError["operation"]) =>
    runner
      .run({
        command: executable,
        args: [
          entryPoint,
          ...args,
          "--extensions-dir",
          extensionsDir,
          "--user-data-dir",
          userDir,
          "--server-data-dir",
          dataDir,
        ],
        timeout: "5 minutes",
      })
      .pipe(
        Effect.mapError((cause) => error(operation, "VSCodium extension command failed.", cause)),
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.void
            : Effect.fail(error(operation, "VSCodium extension command failed.")),
        ),
      );

  const ensureRuntime = Effect.gen(function* () {
    if (!asset) return yield* error("host", "This platform has no VSCodium REH build.");
    yield* fs.makeDirectory(base, { recursive: true });
    yield* Effect.all(
      [extensionsDir, userDir, dataDir].map((dir) => fs.makeDirectory(dir, { recursive: true })),
    );
    if ((yield* fs.exists(executable)) && (yield* fs.exists(entryPoint))) return;
    yield* setHost("downloading");
    const staging = yield* fs.makeTempDirectoryScoped({ directory: base, prefix: ".reh-" });
    const archive = NodePath.join(staging, "reh.tar.gz");
    yield* downloadRehArchive(asset, archive).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    const extracted = NodePath.join(staging, "extract");
    yield* fs.makeDirectory(extracted);
    const unpack = yield* runner.run({
      command: "tar",
      args: ["-xzf", archive, "-C", extracted, "--no-same-owner"],
      timeout: "5 minutes",
    });
    if (unpack.code !== 0) return yield* error("host", "Could not unpack VSCodium REH.");
    const product = yield* parseProduct(
      yield* fs.readFileString(NodePath.join(extracted, "product.json")),
    );
    if (
      product.commit !== "1a46a584725d5dd330e0bcd7f5510f24990efcf2" ||
      product.quality !== "stable"
    ) {
      return yield* error("host", "The downloaded runtime has an unexpected product identity.");
    }
    yield* fs.rename(extracted, serverDir);
  });

  const runHost = Effect.gen(function* () {
    yield* Effect.scoped(ensureRuntime);
    yield* setHost("starting");
    const token = NodeCrypto.randomBytes(32).toString("hex");
    const tokenPath = NodePath.join(base, "connection-token");
    yield* fs.writeFileString(tokenPath, token, { mode: 0o600 });
    const product = yield* parseProduct(
      yield* fs.readFileString(NodePath.join(serverDir, "product.json")),
    );
    if (
      product.commit !== "1a46a584725d5dd330e0bcd7f5510f24990efcf2" ||
      product.quality !== "stable"
    ) {
      return yield* error("host", "The installed runtime has an unexpected product identity.");
    }
    const child = yield* spawner.spawn(
      ChildProcess.make(executable, [
        entryPoint,
        "--host",
        "127.0.0.1",
        "--port",
        "0",
        "--server-base-path",
        BASE_PATH,
        "--connection-token-file",
        tokenPath,
        "--extensions-dir",
        extensionsDir,
        "--user-data-dir",
        userDir,
        "--server-data-dir",
        dataDir,
        "--accept-server-license-terms",
        "--telemetry-level",
        "off",
        ...[...disabled].flatMap((id) => ["--disable-extension", id]),
      ]),
    );
    activeChild = child;
    let stdout = "";
    yield* Stream.runForEach(child.stdout, (chunk) =>
      Effect.gen(function* () {
        stdout += new TextDecoder().decode(chunk);
        const match = /Extension host agent listening on (\d+)/.exec(stdout);
        if (match && !active) {
          active = {
            port: Number(match[1]),
            token,
            commit: product.commit,
            quality: product.quality,
          };
          yield* setHost("ready");
        }
        if (stdout.length > 4096) stdout = stdout.slice(-1024);
      }),
    ).pipe(Effect.forkScoped);
    yield* Stream.runDrain(child.stderr).pipe(Effect.forkScoped);
    yield* Effect.sleep("60 seconds").pipe(
      Effect.flatMap(() => (active ? Effect.void : child.kill())),
      Effect.forkScoped,
    );
    yield* child.exitCode;
    active = null;
    activeChild = null;
    return yield* error("host", "VSCodium REH exited.");
  });

  const supervisor = Effect.gen(function* () {
    let delay = 1000;
    while (true) {
      yield* Effect.scoped(runHost).pipe(
        Effect.catch(() =>
          restarting ? setHost("starting") : setHost("failed", "The extension host stopped."),
        ),
      );
      if (restarting) {
        restarting = false;
        delay = 0;
      }
      yield* Effect.sleep(`${delay} millis`);
      delay = Math.min(Math.max(delay * 2, 1000), 30_000);
    }
  });
  const start = lock.withPermits(1)(
    Effect.gen(function* () {
      if (!asset) return;
      if (!started) {
        started = true;
        yield* Effect.forkIn(supervisor, serviceScope);
      }
    }),
  );
  const ready = Effect.gen(function* () {
    if (!asset) return yield* error("host", "This platform has no VSCodium REH build.");
    yield* start;
    if (active) return active;
    const result = yield* SubscriptionRef.changes(state).pipe(
      Stream.filter((item) => item.host === "ready" || item.host === "failed"),
      Stream.runHead,
    );
    if (Option.isNone(result) || result.value.host !== "ready" || !active) {
      return yield* error(
        "host",
        result.pipe(
          Option.map((item) => item.hostMessage ?? "Extension host failed."),
          Option.getOrElse(() => "Extension host stopped."),
        ),
      );
    }
    return active;
  });
  const connect = ready.pipe(
    Effect.map(({ token, commit, quality }) => ({
      basePath: BASE_PATH,
      connectionToken: token,
      commit,
      quality,
    })),
  );
  const port = ready.pipe(Effect.map(({ port }) => port));

  const restart = Effect.gen(function* () {
    if (!activeChild) return;
    restarting = true;
    active = null;
    yield* setHost("starting");
    yield* activeChild.kill();
  });

  const install = (input: ExtensionInstallInput) =>
    ready.pipe(
      Effect.flatMap(() =>
        lock
          .withPermits(1)(
            Effect.gen(function* () {
              const temporary = yield* fs.makeTempDirectoryScoped({
                directory: base,
                prefix: ".vsix-",
              });
              let vsix: string;
              let expectedId: string;
              if (input.source.type === "vsix") {
                const path = resolveAttachmentPathById({
                  attachmentsDir: config.attachmentsDir,
                  attachmentId: input.source.uploadId,
                });
                if (!path) return yield* error("install", "The uploaded VSIX was not found.");
                vsix = path;
                expectedId = yield* readVsixId(vsix);
              } else {
                expectedId = `${input.source.namespace}.${input.source.name}`;
                const url = openVsxUrl(
                  input.source.namespace,
                  input.source.name,
                  input.source.version,
                );
                const metadata = yield* http.execute(HttpClientRequest.get(url)).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.json),
                );
                const { url: download, sha256Url } = yield* Effect.try({
                  try: () => openVsxDownload(metadata),
                  catch: (cause) => error("install", "Open VSX metadata is invalid.", cause),
                });
                const sha256Text = yield* http.execute(HttpClientRequest.get(sha256Url)).pipe(
                  Effect.flatMap(HttpClientResponse.filterStatusOk),
                  Effect.flatMap((response) => response.text),
                );
                const sha256 = yield* Effect.try({
                  try: () => openVsxSha256(sha256Text),
                  catch: (cause) =>
                    error("install", "Open VSX returned an invalid SHA-256 digest.", cause),
                });
                vsix = NodePath.join(temporary, "extension.vsix");
                const response = yield* http
                  .execute(HttpClientRequest.get(download))
                  .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
                const digest = NodeCrypto.createHash("sha256");
                let bytes = 0;
                yield* response.stream.pipe(
                  Stream.tap((chunk) =>
                    Effect.sync(() => {
                      bytes += chunk.byteLength;
                      digest.update(chunk);
                    }),
                  ),
                  Stream.takeWhile(() => bytes <= MAX_VSIX_BYTES),
                  Stream.run(fs.sink(vsix, { flag: "wx", mode: 0o600 })),
                );
                if (bytes > MAX_VSIX_BYTES || digest.digest("hex") !== sha256)
                  return yield* error("install", "VSIX size or SHA-256 did not match Open VSX.");
              }
              yield* runCli(["--install-extension", vsix, "--force"], "install");
              const extensions = yield* refresh;
              const installed = extensions.find(
                (extension) => extension.id.toLowerCase() === expectedId.toLowerCase(),
              );
              if (!installed)
                return yield* error(
                  "install",
                  "Installed extension was not found in the extension directory.",
                );
              yield* restart;
              return installed;
            }),
          )
          .pipe(Effect.scoped),
      ),
      Effect.mapError((cause) =>
        isExtensionError(cause)
          ? cause
          : error("install", "Could not install the extension.", cause),
      ),
    );
  const uninstall = (id: string) =>
    Effect.scoped(ensureRuntime).pipe(
      Effect.flatMap(() =>
        lock.withPermits(1)(
          Effect.gen(function* () {
            yield* runCli(["--uninstall-extension", id], "uninstall");
            const nextDisabled = new Set(disabled);
            nextDisabled.delete(id.toLowerCase());
            yield* fs.writeFileString(disabledPath, JSON.stringify([...nextDisabled]));
            disabled = nextDisabled;
            yield* refresh;
            yield* restart;
          }),
        ),
      ),
      Effect.mapError((cause) =>
        isExtensionError(cause)
          ? cause
          : error("uninstall", "Could not remove the extension.", cause),
      ),
    );
  const setEnabled = (id: string, enabled: boolean) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const installed = yield* refresh;
          if (!installed.some((extension) => extension.id.toLowerCase() === id.toLowerCase()))
            return yield* error("setEnabled", "Extension is not installed.");
          const nextDisabled = new Set(disabled);
          if (enabled) nextDisabled.delete(id.toLowerCase());
          else nextDisabled.add(id.toLowerCase());
          yield* fs.writeFileString(disabledPath, JSON.stringify([...nextDisabled]));
          disabled = nextDisabled;
          yield* refresh;
          yield* restart;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isExtensionError(cause)
            ? cause
            : error("setEnabled", "Could not save the extension setting.", cause),
        ),
      );
  const iconPath = (id: string, relative?: string) =>
    Effect.tryPromise({
      try: async () => {
        for (const entry of await NodeFSP.readdir(extensionsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const directory = NodePath.join(extensionsDir, entry.name);
          try {
            const manifest = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "package.json"), "utf8"),
            ) as { publisher?: string; name?: string; icon?: string };
            if (
              `${manifest.publisher}.${manifest.name}`.toLowerCase() !== id.toLowerCase() ||
              !(relative ?? manifest.icon)
            )
              continue;
            if (!/\.(?:svg|png|jpe?g|gif|webp|ico)$/i.test(relative ?? manifest.icon!)) return null;
            const file = await NodeFSP.realpath(
              NodePath.resolve(directory, relative ?? manifest.icon!),
            );
            const root = await NodeFSP.realpath(directory);
            if (!file.startsWith(`${root}${NodePath.sep}`)) return null;
            return file;
          } catch {
            continue;
          }
        }
        return null;
      },
      catch: () => error("list", "Could not read extension icon."),
    }).pipe(Effect.orElseSucceed(() => null));
  yield* fs.makeDirectory(extensionsDir, { recursive: true });
  yield* refresh;
  return ExtensionHost.of({
    subscribe: SubscriptionRef.changes(state),
    connect,
    port,
    install,
    uninstall,
    setEnabled,
    iconPath,
  });
});
