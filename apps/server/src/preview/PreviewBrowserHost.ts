/**
 * Host setup the shared headless browser needs, and the one command that does
 * it. Every failure here names that command, so the server log, an agent's tool
 * error, and the viewer all offer the same fix: `sudo t3 browser setup`.
 *
 * T3 never turns Chrome's sandbox off by itself. A host that cannot give it one
 * gets the command instead, and only the operator's explicit
 * `T3CODE_SERVER_BROWSER_SANDBOX=0` launches without it.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** The subcommand that sets the host up; callers render it, with `sudo`, for how T3 was launched. */
export const SETUP_SUBCOMMAND = "browser setup";

/** What Chrome prints before aborting when it cannot sandbox itself. */
export const NO_SANDBOX_SIGNATURE = "No usable sandbox";

/** Whether an operator explicitly allowed Chrome to run without its sandbox. */
export const sandboxDisabled = (env: Readonly<Record<string, string | undefined>>) =>
  env.T3CODE_SERVER_BROWSER_SANDBOX === "0";

/** Set on Ubuntu 23.10+: unprivileged user namespaces need an AppArmor profile. */
const USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
export const APPARMOR_PROFILE_PATH = "/etc/apparmor.d/t3-chrome-headless-shell";

/**
 * Lets T3's headless browser, in any T3 home and at any pinned version, create
 * the user namespace Chrome's sandbox runs in. Modelled on the profile Ubuntu
 * ships for Google Chrome; `unconfined` adds nothing beyond `userns`.
 */
export const APPARMOR_PROFILE = `# Written by \`t3 browser setup\`: lets T3 Code's headless browser use Chrome's sandbox.
abi <abi/4.0>,
include <tunables/global>

profile t3-chrome-headless-shell /**/tools/chrome-headless-shell/*/*/chrome-headless-shell flags=(unconfined) {
  userns,

  include if exists <local/t3-chrome-headless-shell>
}
`;

/**
 * Chrome's Debian dependencies that minimal images leave out, from the headless
 * shell's deb.deps. Ubuntu 24.04 and Debian 13 renamed some with a `t64`
 * suffix; setup installs whichever name the host's apt offers.
 */
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

export type PreviewBrowserHostError = PreviewBrowserSandboxError | PreviewBrowserLibrariesError;

const MISSING_LIBRARY = /^\s*(\S+) => not found$/gm;
/** glibc's loader abort, naming the first library it could not load. */
const LOADER_ERROR = /error while loading shared libraries: ([^:\s]+)/;

/**
 * After a launch fails, names the host setup it is missing: the sandbox, from
 * Chrome's own abort message, or shared libraries the loader refuses. Undefined
 * when neither explains it. Linux only; other hosts never need either.
 */
export const diagnoseLaunchFailure = Effect.fn("PreviewBrowserHost.diagnoseLaunchFailure")(
  function* (input: {
    readonly executable: string;
    readonly output: string;
    readonly setupCommand: string;
  }) {
    const { setupCommand } = input;
    if (input.output.includes(NO_SANDBOX_SIGNATURE)) {
      return new PreviewBrowserSandboxError({ setupCommand });
    }
    if ((yield* HostProcessPlatform) !== "linux") return undefined;
    const libraries = yield* missingLibraries(input.executable);
    return libraries.length === 0
      ? undefined
      : new PreviewBrowserLibrariesError({ setupCommand, libraries });
  },
);

/**
 * Shared libraries the loader cannot find for `executable`. The browser's own
 * `--version` decides whether any are missing; `ldd` only lists them after the
 * real loader fails, because it can report libraries a host provides another
 * way (NixOS's nix-ld).
 */
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

/**
 * Whether Chrome's sandbox will be blocked here: the host restricts user
 * namespaces and T3's AppArmor profile is not installed. Readable without
 * root, so the server checks it at startup.
 */
export const sandboxBlocked = Effect.gen(function* () {
  if ((yield* HostProcessPlatform) !== "linux") return false;
  const fs = yield* FileSystem.FileSystem;
  const restricted = yield* fs.readFileString(USERNS_RESTRICTION).pipe(
    Effect.map((value) => value.trim() === "1"),
    Effect.orElseSucceed(() => false),
  );
  if (!restricted) return false;
  return !(yield* fs.exists(APPARMOR_PROFILE_PATH).pipe(Effect.orElseSucceed(() => false)));
}).pipe(Effect.withSpan("PreviewBrowserHost.sandboxBlocked"));
