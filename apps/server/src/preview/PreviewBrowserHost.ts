import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Digest is a service; a nickname needs only a plain hash.
import * as NodeCrypto from "node:crypto";

export const SETUP_SUBCOMMAND = "browser setup";

export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome-headless-shell";

/** Match Ubuntu's Chrome profile; unconfined adds nothing beyond userns. */
export const APPARMOR_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`;

/** Ubuntu 24.04 and Debian 13 use some t64 library names; choose names available through apt. */
export const DEBIAN_PACKAGES: ReadonlyArray<ReadonlyArray<string>> = [
  ["libnss3"],
  ["libglib2.0-0t64", "libglib2.0-0"],
  ["libatk1.0-0t64", "libatk1.0-0"],
  ["libatk-bridge2.0-0t64", "libatk-bridge2.0-0"],
  ["libatspi2.0-0t64", "libatspi2.0-0"],
  ["libdbus-1-3"],
  ["libx11-6"],
  ["libxcb1"],
  ["libxcomposite1"],
  ["libxdamage1"],
  ["libxext6"],
  ["libxfixes3"],
  ["libxrandr2"],
  ["libxkbcommon0"],
  ["libgbm1"],
  ["libasound2t64", "libasound2"],
  ["libexpat1"],
];

export class PreviewBrowserSandboxError extends Schema.TaggedError<PreviewBrowserSandboxError>()(
  "PreviewBrowserSandboxError",
  { setupCommand: Schema.String },
) {
  override get message(): string {
    return `This host blocks the sandbox T3's browser runs in (AppArmor on Ubuntu 23.10+). Run \`${this.setupCommand}\` on the host once to allow it, then try again.`;
  }
}

export class PreviewBrowserLibrariesError extends Schema.TaggedError<PreviewBrowserLibrariesError>()(
  "PreviewBrowserLibrariesError",
  { setupCommand: Schema.String, libraries: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `This host is missing libraries T3's browser needs (${this.libraries.join(", ")}). Run \`${this.setupCommand}\` on the host to install them, then try again.`;
  }
}

/** Chrome will not start its sandbox as root (crbug.com/638180), which no host setup fixes. */
export class PreviewBrowserRootError extends Schema.TaggedError<PreviewBrowserRootError>()(
  "PreviewBrowserRootError",
  {},
) {
  override get message(): string {
    return "T3 server is running as root; Chrome's sandbox cannot start. Run T3 as a nonroot user. Otherwise set `T3CODE_SERVER_BROWSER_SANDBOX=0` in the T3 server's environment and restart the server; this disables Chrome's sandbox. Manual: `T3CODE_SERVER_BROWSER_SANDBOX=0 t3 serve`. Systemd: add `Environment=T3CODE_SERVER_BROWSER_SANDBOX=0` under `[Service]`, reload systemd, then restart the service. `t3 browser setup` cannot fix root sandboxing.";
  }
}

export type PreviewBrowserHostError =
  | PreviewBrowserSandboxError
  | PreviewBrowserLibrariesError
  | PreviewBrowserRootError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      // Playwright reports Chrome's refusal to sandbox as root as a sandbox failure too.
      return (yield* HostProcess.UserId) === 0
        ? new PreviewBrowserRootError()
        : new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcess.Platform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);

/** Detect missing libraries with --version; ldd can report misses that NixOS nix-ld provides. */
export const missingLibraries = Effect.fn("PreviewBrowserHost.missingLibraries")(function* (
  executable: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    spawner
      .string(ChildProcess.make(command, args, { stdin: "ignore" }), { includeStderr: true })
      .pipe(
        Effect.timeout("5 seconds"),
        Effect.orElseSucceed(() => ""),
      );
  const loaderError = LOADER_ERROR.exec(yield* run(executable, ["--version"]))?.[1];
  if (loaderError === undefined) return [];
  const listed = [...(yield* run("ldd", [executable])).matchAll(MISSING_LIBRARY)].map(
    (match) => match[1]!,
  );
  return listed.length > 0 ? listed : [loaderError];
});

export const sandboxBlocked = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  if (!restricted) return false;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));

/**
 * Where an administrator adds roots to the system store: Debian and Alpine, RHEL, Arch, SUSE.
 * The first holds one certificate per `.crt` file; p11-kit reads every file in the others.
 */
const LOCAL_CA_DIRECTORIES = [
  { directory: "/usr/local/share/ca-certificates", extension: ".crt" },
  { directory: "/etc/pki/ca-trust/source/anchors" },
  { directory: "/etc/ca-certificates/trust-source/anchors" },
  { directory: "/etc/pki/trust/anchors" },
];

export const CERTUTIL_PACKAGE = "libnss3-tools";

/** Chrome on Linux trusts its own roots and the user's NSS database, never the system store. */
export const localCertificates = Effect.gen(function* () {
  if ((yield* HostProcess.Platform) !== "linux") return [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found = yield* Effect.forEach(LOCAL_CA_DIRECTORIES, ({ directory, extension }) =>
    fs.readDirectory(directory, { recursive: true }).pipe(
      Effect.map((names) =>
        names
          .filter((name) => extension === undefined || name.endsWith(extension))
          .map((name) => path.join(directory, name)),
      ),
      Effect.orElseSucceed(() => []),
    ),
  );
  return found.flat();
}).pipe(Effect.withSpan("PreviewBrowserHost.localCertificates"));

const runCertutil = Effect.fn("PreviewBrowserHost.runCertutil")(function* (
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .exitCode(
      ChildProcess.make("certutil", args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
    )
    .pipe(Effect.timeout("5 seconds"), Effect.option);
});

export const certutilAvailable = runCertutil(["-H"]).pipe(
  Effect.map(Option.isSome),
  Effect.withSpan("PreviewBrowserHost.certutilAvailable"),
);

/**
 * Imports the system store's local roots into the NSS database Chrome reads. False means certutil
 * could not run, so the roots stay untrusted until it is installed.
 */
export const trustLocalCertificates = Effect.gen(function* () {
  const certificates = yield* localCertificates;
  if (certificates.length === 0) return true;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  // Chrome opens ~/.pki/nssdb when it exists and the XDG data directory's database otherwise.
  const legacy = path.join(home, ".pki", "nssdb");
  const database = (yield* fs.exists(legacy).pipe(Effect.orElseSucceed(() => false)))
    ? legacy
    : path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "pki", "nssdb");
  yield* fs.makeDirectory(database, { recursive: true, mode: 0o700 }).pipe(Effect.ignore);
  for (const certificate of certificates) {
    const bytes = yield* fs.readFile(certificate).pipe(Effect.option);
    if (Option.isNone(bytes)) continue;
    // NSS refuses a nickname another certificate holds, so a replaced file needs a new one.
    const digest = NodeCrypto.createHash("sha256").update(bytes.value).digest("hex");
    const imported = yield* runCertutil([
      "-d",
      `sql:${database}`,
      "-A",
      "-t",
      "C,,",
      "-n",
      `T3 Code system CA ${digest.slice(0, 16)}`,
      "-i",
      certificate,
    ]);
    if (Option.isNone(imported)) return false;
  }
  return true;
}).pipe(Effect.withSpan("PreviewBrowserHost.trustLocalCertificates"));

export const UNTRUSTED_CERTIFICATE = "ERR_CERT_AUTHORITY_INVALID";

export const untrustedCertificateNote = (setupCommand: string) =>
  `This host's own CA certificates are not trusted by T3's browser, so HTTPS resources they sign fail to load. Run \`${setupCommand}\` on the host to install certutil, then try again.`;
