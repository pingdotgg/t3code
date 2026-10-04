/**
 * The Chromium the environment server runs for server-side preview tabs.
 *
 * Servers are often GPU-less containers without root or Chrome's system
 * libraries, so on glibc Linux we install a pinned headless build from the
 * `@sparticuz/chromium` GitHub release (its npm package ships x64 only): the
 * executable with SwiftShader beside it, and NSS/NSPR/expat in `lib/` for
 * `LD_LIBRARY_PATH`. A private fontconfig file layers optional T3-owned emoji
 * and CJK fonts over whatever the system has. Everywhere else nothing is
 * downloaded: we use an installed Chrome, Chromium, or Edge, or a Playwright
 * cache build.
 *
 * Installs follow the pinned-runtime recipe: stage into a temp sibling, write
 * the sentinel only after the tree is complete (and, for the browser, after
 * the executable runs), then rename into place.
 */
import * as NodeStream from "@effect/platform-node/NodeStream";
import {
  HostProcessArchitecture,
  HostProcessEnvironment,
  HostProcessPlatform,
} from "@t3tools/shared/hostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

/** `@sparticuz/chromium` release; ships Chromium 153.0.8010.0. */
const SERVER_BROWSER_VERSION = "153.0.0";
/** Bump when `FONTS` changes. */
const FONTS_VERSION = "1";

interface PinnedAsset {
  readonly url: string;
  readonly sha256: string;
}

const RELEASE_URL = `https://github.com/Sparticuz/chromium/releases/download/v${SERVER_BROWSER_VERSION}`;
const BROWSER_PACKS: Partial<Record<string, PinnedAsset>> = {
  x64: {
    url: `${RELEASE_URL}/chromium-v${SERVER_BROWSER_VERSION}-pack.x64.tar`,
    sha256: "91b9f56d35a2cbb14279a1cbdaf1c86c0faa5fd82315bdd7334ff93bf35f224d",
  },
  arm64: {
    url: `${RELEASE_URL}/chromium-v${SERVER_BROWSER_VERSION}-pack.arm64.tar`,
    sha256: "b6874fc0d7af15e16a15ef1b73177731f698c296c73d26aa4a90840c0777a338",
  },
};

// Emoji must be the CBDT build; this Chromium does not render the COLRv1 one.
const FONTS: ReadonlyArray<PinnedAsset & { readonly file: string }> = [
  {
    file: "NotoColorEmoji.ttf",
    url: "https://raw.githubusercontent.com/googlefonts/noto-emoji/v2.051/fonts/NotoColorEmoji.ttf",
    sha256: "72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b",
  },
  {
    file: "NotoSansCJK-Regular.ttc",
    url: "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/NotoSansCJK-Regular.ttc",
    sha256: "b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a",
  },
  {
    file: "NotoSansCJK-Bold.ttc",
    url: "https://raw.githubusercontent.com/notofonts/noto-cjk/Sans2.004/Sans/OTC/NotoSansCJK-Bold.ttc",
    sha256: "faa5f3656a78b2e2d450d27fe8382c778bc2b6bb5ea29c986664a6a435056ceb",
  },
];

const BROWSER_TOOL = "server-browser";
const FONTS_TOOL = "server-browser-fonts";
const SENTINEL = ".install-complete";

const xmlText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * Our cache dir comes first so fontconfig writes there (a relative cachedir
 * resolves against the cwd, so it must be absolute). <dir> is scanned
 * recursively and dot entries are skipped, so the fonts tool's staging dirs
 * stay invisible and whichever fonts version is installed gets picked up.
 */
const fontconfigFile = (
  browserDir: string,
  fontsToolDir: string,
  path: Path.Path,
) => `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <cachedir>${xmlText(path.join(browserDir, "fontconfig-cache"))}</cachedir>
  <include ignore_missing="yes">/etc/fonts/fonts.conf</include>
  <dir>${xmlText(path.join(browserDir, "fonts"))}</dir>
  <dir>${xmlText(fontsToolDir)}</dir>
</fontconfig>
`;

const BROWSER_INSTALL_TIMEOUT = Duration.minutes(10);
const FONTS_INSTALL_TIMEOUT = Duration.minutes(3);
const FONTS_LAUNCH_WAIT = Duration.seconds(1);
const browserInstallLock = Semaphore.makeUnsafe(1);
const fontsInstallLock = Semaphore.makeUnsafe(1);

export type ServerBrowserSource = "override" | "bundled" | "system" | "playwright-cache";

export interface ServerBrowserLaunch {
  readonly executablePath: string;
  /** Merge over the server's environment when spawning. */
  readonly env: Readonly<Record<string, string>>;
  /** Flags this build needs beyond the launcher's own. */
  readonly args: ReadonlyArray<string>;
  readonly source: ServerBrowserSource;
}

export class ServerBrowserInstallError extends Schema.TaggedError<ServerBrowserInstallError>()(
  "ServerBrowserInstallError",
  {
    tool: Schema.String,
    step: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Installing ${this.tool} failed while ${this.step}.`;
  }
}

export class ServerBrowserNotFoundError extends Schema.TaggedError<ServerBrowserNotFoundError>()(
  "ServerBrowserNotFoundError",
  {
    platform: Schema.String,
    architecture: Schema.String,
    override: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.override === undefined
      ? `No Chrome, Chromium, or Edge was found on ${this.platform}/${this.architecture}. Install one or set T3CODE_PREVIEW_BROWSER_PATH.`
      : `T3CODE_PREVIEW_BROWSER_PATH points at '${this.override}', which is not an executable.`;
  }
}

export type ServerBrowserToolchainError = ServerBrowserInstallError | ServerBrowserNotFoundError;

export class ServerBrowserToolchain extends Context.Service<
  ServerBrowserToolchain,
  {
    /** Installs the bundled build on first use; later calls only read sentinels. */
    readonly resolve: Effect.Effect<ServerBrowserLaunch, ServerBrowserToolchainError>;
  }
>()("t3/preview/ServerBrowserToolchain") {}

interface TarEntry {
  readonly name: string;
  readonly type: string;
  readonly mode: number;
  readonly data: Uint8Array;
}

/** Reads the plain GNU/ustar tarballs in the pinned pack: files, directories, long names. */
const readTar = (archive: Uint8Array): ReadonlyArray<TarEntry> => {
  const decoder = new TextDecoder();
  const text = (bytes: Uint8Array) => decoder.decode(bytes).replace(/\0[\s\S]*$/, "");
  const entries: Array<TarEntry> = [];
  let longName: string | undefined;
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) => text(header.subarray(start, start + length));
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const data = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    const type = field(156, 1) || "0";
    if (type === "L") {
      longName = text(data);
      continue;
    }
    // Only POSIX ustar has a prefix field; old GNU headers keep other data there.
    const prefix = field(257, 6) === "ustar" ? field(345, 155) : "";
    const name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    entries.push({ name, type, mode: Number.parseInt(field(100, 8).trim() || "644", 8), data });
  }
  return entries;
};

const brotliDecompress = NodeUtil.promisify(NodeZlib.brotliDecompress);

const hostUsesGlibc = (): boolean => {
  try {
    const report = process.report?.getReport() as
      | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime === "string";
  } catch {
    return false;
  }
};

const systemBrowserCandidates = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  path: Path.Path,
): ReadonlyArray<string> => {
  if (platform === "darwin") {
    const apps = [
      "Google Chrome.app/Contents/MacOS/Google Chrome",
      "Chromium.app/Contents/MacOS/Chromium",
      "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    const roots = ["/Applications", ...(env.HOME ? [path.join(env.HOME, "Applications")] : [])];
    return apps.flatMap((app) => roots.map((root) => path.join(root, app)));
  }
  if (platform === "win32") {
    const apps = [
      "Google\\Chrome\\Application\\chrome.exe",
      "Microsoft\\Edge\\Application\\msedge.exe",
      "Chromium\\Application\\chrome.exe",
    ];
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(
      (root): root is string => Boolean(root),
    );
    return apps.flatMap((app) => roots.map((root) => path.join(root, app)));
  }
  return [
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "microsoft-edge-stable",
    "microsoft-edge",
  ];
};

/** `chromium_headless_shell-<revision>/<these>`, from playwright-core's registry. */
const PLAYWRIGHT_HEADLESS_SHELL: Partial<Record<string, ReadonlyArray<string>>> = {
  "linux-x64": ["chrome-headless-shell-linux64", "chrome-headless-shell"],
  "linux-arm64": ["chrome-linux", "headless_shell"],
  "darwin-x64": ["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
  "darwin-arm64": ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
  "win32-x64": ["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
};

const playwrightCacheDir = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  path: Path.Path,
  playwrightRoot: string | undefined,
): string | undefined => {
  // Playwright's rules: "0" is the hermetic install beside playwright-core,
  // and a relative path is relative to where the install ran.
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured === "0") {
    return playwrightRoot === undefined ? undefined : path.join(playwrightRoot, ".local-browsers");
  }
  if (configured) return path.resolve(env.INIT_CWD || ".", configured);
  if (platform === "win32") {
    return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "ms-playwright") : undefined;
  }
  if (!env.HOME) return undefined;
  return platform === "darwin"
    ? path.join(env.HOME, "Library", "Caches", "ms-playwright")
    : path.join(env.XDG_CACHE_HOME || path.join(env.HOME, ".cache"), "ms-playwright");
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const runner = yield* ProcessRunner.ProcessRunner;
  const platform = yield* HostProcessPlatform;
  const architecture = yield* HostProcessArchitecture;
  const hostEnv = yield* HostProcessEnvironment;

  const toolsDir = path.join(config.baseDir, "tools");
  const browserDir = path.join(toolsDir, BROWSER_TOOL, SERVER_BROWSER_VERSION);
  const browserPack =
    platform === "linux" && hostUsesGlibc() ? BROWSER_PACKS[architecture] : undefined;

  const isInstalled = (installDir: string, version: string) =>
    fs.readFileString(path.join(installDir, SENTINEL)).pipe(
      Effect.map((sentinel) => sentinel.trim() === version),
      Effect.orElseSucceed(() => false),
    );

  /** Stages and atomically publishes `<baseDir>/tools/<tool>/<version>` if not already complete. */
  const installOnce = Effect.fn("ServerBrowserToolchain.installOnce")(function* (
    tool: string,
    version: string,
    populate: (stagingDir: string) => Effect.Effect<void, ServerBrowserInstallError>,
  ) {
    const fail = (step: string) => (cause: unknown) =>
      new ServerBrowserInstallError({ tool, step, cause });
    const parentDir = path.join(toolsDir, tool);
    const installDir = path.join(parentDir, version);
    if (yield* isInstalled(installDir, version)) return;

    yield* fs
      .makeDirectory(parentDir, { recursive: true })
      .pipe(Effect.mapError(fail("preparing the install directory")));
    const stagingDir = yield* fs
      .makeTempDirectory({ directory: parentDir, prefix: ".staging-" })
      .pipe(Effect.mapError(fail("preparing the install directory")));

    yield* Effect.gen(function* () {
      yield* populate(stagingDir);
      yield* fs
        .writeFileString(path.join(stagingDir, SENTINEL), `${version}\n`)
        .pipe(Effect.mapError(fail("recording the completed install")));
      // Published versions may be in use by other servers. Never remove them;
      // rename cannot replace a completed, nonempty install directory.
      yield* fs.rename(stagingDir, installDir).pipe(
        Effect.catch((cause) =>
          // A concurrent server may have published the same version first.
          isInstalled(installDir, version).pipe(
            Effect.flatMap((published) =>
              published ? Effect.void : Effect.fail(fail("publishing the install")(cause)),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
    );
  });

  const download = Effect.fn("ServerBrowserToolchain.download")(function* (
    tool: string,
    asset: PinnedAsset,
  ) {
    const bytes = yield* httpClient.execute(HttpClientRequest.get(asset.url)).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer)),
      Effect.mapError(
        (cause) => new ServerBrowserInstallError({ tool, step: `downloading ${asset.url}`, cause }),
      ),
    );
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
      return yield* new ServerBrowserInstallError({ tool, step: `verifying ${asset.url}` });
    }
    return bytes;
  });

  const launchEnv = (installDir: string): Record<string, string> => ({
    LD_LIBRARY_PATH: [path.join(installDir, "lib"), hostEnv.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(":"),
    FONTCONFIG_FILE: path.join(installDir, "fonts.conf"),
  });

  const populateBrowser = (pack: PinnedAsset) =>
    Effect.fn("ServerBrowserToolchain.populateBrowser")(function* (stagingDir: string) {
      const fail = (step: string) => (cause: unknown) =>
        new ServerBrowserInstallError({ tool: BROWSER_TOOL, step, cause });
      const members = new Map(
        readTar(yield* download(BROWSER_TOOL, pack)).map((entry) => [entry.name, entry.data]),
      );
      const member = (name: string) => {
        const data = members.get(name);
        return data === undefined
          ? Effect.fail(
              new ServerBrowserInstallError({ tool: BROWSER_TOOL, step: `finding ${name}` }),
            )
          : Effect.succeed(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
      };

      // Stream the ~200 MB executable to disk instead of inflating it in memory.
      const executablePath = path.join(stagingDir, "chromium");
      const chromium = yield* member("chromium.br");
      yield* Stream.succeed(chromium).pipe(
        NodeStream.pipeThroughSimple(() => NodeZlib.createBrotliDecompress()),
        Stream.run(fs.sink(executablePath, { mode: 0o755 })),
        Effect.mapError(fail("unpacking chromium.br")),
      );

      // SwiftShader sits beside the executable, NSS/NSPR/expat land in lib/,
      // and fonts.tar adds Open Sans for hosts with no fonts at all.
      for (const name of ["swiftshader.tar.br", "al2023.tar.br", "fonts.tar.br"]) {
        const compressed = yield* member(name);
        const archive = yield* Effect.tryPromise({
          try: () => brotliDecompress(compressed),
          catch: fail(`unpacking ${name}`),
        });
        for (const entry of readTar(archive)) {
          const target = path.resolve(stagingDir, entry.name);
          if (
            !target.startsWith(stagingDir + path.sep) ||
            (entry.type !== "0" && entry.type !== "5")
          ) {
            return yield* fail(`unpacking ${name}`)(
              `Unsupported entry ${entry.type} ${entry.name}`,
            );
          }
          yield* (
            entry.type === "5"
              ? fs.makeDirectory(target, { recursive: true })
              : fs
                  .makeDirectory(path.dirname(target), { recursive: true })
                  .pipe(Effect.andThen(fs.writeFile(target, entry.data, { mode: entry.mode })))
          ).pipe(Effect.mapError(fail(`unpacking ${name}`)));
        }
      }
      // Replaces the Lambda-specific fonts.conf from fonts.tar.
      yield* fs
        .writeFileString(
          path.join(stagingDir, "fonts.conf"),
          fontconfigFile(browserDir, path.join(toolsDir, FONTS_TOOL), path),
        )
        .pipe(Effect.mapError(fail("writing fonts.conf")));

      // Proves the loader finds every library before the install counts.
      const result = yield* runner
        .run({
          command: executablePath,
          args: ["--version"],
          env: launchEnv(stagingDir),
          timeout: Duration.seconds(30),
        })
        .pipe(Effect.mapError(fail("running chromium --version")));
      if (result.code !== 0 || !result.stdout.includes("Chromium")) {
        return yield* fail("running chromium --version")(result);
      }
    });

  const populateFonts = Effect.fn("ServerBrowserToolchain.populateFonts")(function* (
    stagingDir: string,
  ) {
    yield* Effect.forEach(
      FONTS,
      (font) =>
        download(FONTS_TOOL, font).pipe(
          Effect.flatMap((bytes) =>
            fs.writeFile(path.join(stagingDir, font.file), bytes).pipe(
              Effect.mapError(
                (cause) =>
                  new ServerBrowserInstallError({
                    tool: FONTS_TOOL,
                    step: `saving ${font.file}`,
                    cause,
                  }),
              ),
            ),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  // Fonts are optional: one attempt per server process that never fails the
  // browser. It runs detached so a cancelled or failed resolve cannot
  // interrupt it, which would cache the interruption for every later call.
  const fontsFiber = yield* Effect.cached(
    Effect.forkDetach(
      fontsInstallLock.withPermit(installOnce(FONTS_TOOL, FONTS_VERSION, populateFonts)).pipe(
        Effect.timeoutOrElse({
          duration: FONTS_INSTALL_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ServerBrowserInstallError({ tool: FONTS_TOOL, step: "downloading (timed out)" }),
            ),
        }),
        Effect.catch((cause) =>
          Effect.logWarning("Preview browser fonts unavailable; emoji and CJK may not render", {
            cause,
          }),
        ),
      ),
    ),
  );
  // The first launch waits briefly for fonts, then goes without; later
  // launches pick them up once the background install lands.
  const ensureFonts = Effect.flatMap(fontsFiber, (fiber) =>
    Fiber.join(fiber).pipe(Effect.timeoutOption(FONTS_LAUNCH_WAIT), Effect.asVoid),
  );

  const bundledLaunch: ServerBrowserLaunch = {
    executablePath: path.join(browserDir, "chromium"),
    env: launchEnv(browserDir),
    args: [],
    source: "bundled",
  };
  const bundled = (pack: PinnedAsset) =>
    Effect.all(
      [
        browserInstallLock
          .withPermit(installOnce(BROWSER_TOOL, SERVER_BROWSER_VERSION, populateBrowser(pack)))
          .pipe(
            Effect.timeoutOrElse({
              duration: BROWSER_INSTALL_TIMEOUT,
              orElse: () =>
                Effect.fail(
                  new ServerBrowserInstallError({
                    tool: BROWSER_TOOL,
                    step: "installing (timed out)",
                  }),
                ),
            }),
          ),
        ensureFonts,
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.as(bundledLaunch));

  /** Resolves bare names through PATH and checks absolute paths are executable. */
  const executable = (candidate: string) =>
    resolveCommandPath(candidate).pipe(
      Effect.option,
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const firstExecutable = Effect.fn("ServerBrowserToolchain.firstExecutable")(function* (
    candidates: ReadonlyArray<string>,
  ) {
    for (const candidate of candidates) {
      const resolved = yield* executable(candidate);
      if (Option.isSome(resolved)) return resolved.value;
    }
    return undefined;
  });

  const discover = Effect.gen(function* () {
    const system = yield* firstExecutable(systemBrowserCandidates(platform, hostEnv, path));
    if (system !== undefined) {
      return {
        executablePath: system,
        env: {},
        args: [],
        source: "system",
      } satisfies ServerBrowserLaunch;
    }
    const playwrightRoot = yield* Effect.try(() =>
      import.meta.resolve("playwright-core/package.json"),
    ).pipe(
      Effect.flatMap((url) => path.fromFileUrl(new URL(url))),
      Effect.map((file) => path.dirname(file)),
      Effect.option,
    );
    const cacheDir = playwrightCacheDir(
      platform,
      hostEnv,
      path,
      Option.getOrUndefined(playwrightRoot),
    );
    const relative = PLAYWRIGHT_HEADLESS_SHELL[`${platform}-${architecture}`];
    if (cacheDir !== undefined && relative !== undefined) {
      const revisions = (yield* fs.readDirectory(cacheDir).pipe(Effect.orElseSucceed(() => [])))
        .flatMap((name) => {
          const match = /^chromium_headless_shell-(\d+)$/.exec(name);
          return match ? [{ name, revision: Number(match[1]) }] : [];
        })
        .sort((left, right) => right.revision - left.revision);
      const cached = yield* firstExecutable(
        revisions.map(({ name }) => path.join(cacheDir, name, ...relative)),
      );
      if (cached !== undefined) {
        return {
          executablePath: cached,
          env: {},
          args: [],
          source: "playwright-cache",
        } satisfies ServerBrowserLaunch;
      }
    }
    return yield* new ServerBrowserNotFoundError({ platform, architecture });
  });

  const resolve: ServerBrowserToolchain["Service"]["resolve"] = Effect.gen(function* () {
    const override = hostEnv.T3CODE_PREVIEW_BROWSER_PATH;
    if (override) {
      const resolved = yield* executable(override);
      if (Option.isNone(resolved)) {
        return yield* new ServerBrowserNotFoundError({ platform, architecture, override });
      }
      const libraryPath = hostEnv.T3CODE_PREVIEW_BROWSER_LD_LIBRARY_PATH;
      return {
        executablePath: resolved.value,
        env: libraryPath ? { LD_LIBRARY_PATH: libraryPath } : {},
        args: [],
        source: "override",
      } satisfies ServerBrowserLaunch;
    }
    if (browserPack === undefined) return yield* discover;
    // Offline with a system browser still works; otherwise report the install failure.
    return yield* bundled(browserPack).pipe(
      Effect.catch((installError) =>
        Effect.logWarning("Bundled preview browser unavailable; looking for a system browser", {
          cause: installError,
        }).pipe(
          Effect.andThen(discover),
          Effect.catchTag("ServerBrowserNotFoundError", () => Effect.fail(installError)),
        ),
      ),
    );
  });

  return ServerBrowserToolchain.of({ resolve });
});

export const layer = Layer.effect(ServerBrowserToolchain, make);
