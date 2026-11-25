import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SshPasswordPromptError } from "./errors.ts";

export interface SshPasswordRequest {
  readonly destination: string;
  readonly username: string | null;
  readonly prompt: string;
  readonly attempt: number;
}

interface SshAskpassFile {
  readonly path: string;
  readonly contents: string;
  readonly mode?: number;
}

export interface SshAskpassHelperDescriptor {
  readonly helperPath: string;
  readonly files: ReadonlyArray<SshAskpassFile>;
}

export interface SshAuthOptions {
  readonly authSecret?: string | null;
  readonly batchMode?: "yes" | "no";
  readonly interactiveAuth?: boolean;
}

export interface SshPasswordPromptShape {
  readonly isAvailable: boolean;
  readonly request: (
    request: SshPasswordRequest,
  ) => Effect.Effect<string | null, SshPasswordPromptError>;
}

export class SshPasswordPrompt extends Context.Service<SshPasswordPrompt, SshPasswordPromptShape>()(
  "@t3tools/ssh/auth/SshPasswordPrompt",
) {
  static readonly disabledLayer = Layer.succeed(
    SshPasswordPrompt,
    SshPasswordPrompt.of({
      isAvailable: false,
      request: Effect.fn("SshPasswordPrompt.request")(function () {
        return Effect.succeed(null);
      }),
    }),
  );
}

export interface SshChildEnvironmentOptions {
  readonly interactiveAuth?: boolean;
  readonly baseEnv?: NodeJS.ProcessEnv;
  readonly askpassDirectory?: string;
  readonly authSecret?: string | null;
}

const SSH_ASKPASS_DIR_NAME = "t3code-ssh-askpass";

function joinSshAskpassPath(
  directory: string,
  fileName: string,
  platform: NodeJS.Platform,
): string {
  const trimmed = directory.replace(/[\\/]+$/u, "");
  return platform === "win32" ? `${trimmed}\\${fileName}` : `${trimmed}/${fileName}`;
}

const ASKPASS_POSIX_SCRIPT = `#!/bin/sh
# Invoked by ssh via SSH_ASKPASS when T3 Code re-runs ssh with a cached password
# from the renderer's in-app prompt. We never expose a native dialog here - if
# T3_SSH_AUTH_SECRET is missing, that's a caller bug and we fail loudly.
if [ "\${T3_SSH_AUTH_SECRET+x}" = "x" ]; then
  printf "%s\\n" "$T3_SSH_AUTH_SECRET"
  exit 0
fi
printf 'T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.\\n' >&2
exit 1
`;

// Windows has no helper form every ssh can start. Win32-OpenSSH starts `"<node>" "<this file>"`
// directly; Cygwin/MSYS ssh (Git for Windows) execs ssh-askpass.sh through its own sh. Either
// way ssh appends the prompt as a plain trailing argument, which the helpers never read.
const ASKPASS_WINDOWS_NODE_SCRIPT = `// Invoked by ssh via SSH_ASKPASS when T3 Code re-runs ssh with a cached password
// from the renderer's in-app prompt. Answers from T3_SSH_AUTH_SECRET only and
// never reads its arguments; if the secret is missing, that's a caller bug and
// we fail loudly.
if ("T3_SSH_AUTH_SECRET" in process.env) {
  process.stdout.write((process.env.T3_SSH_AUTH_SECRET || "") + "\\n");
  process.exit(0);
}
process.stderr.write("T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.\\n");
process.exit(1);
`;

const buildSshAskpassHelperDescriptor = Effect.fn("ssh/auth.buildSshAskpassHelperDescriptor")(
  function* (input: {
    readonly directory: string;
  }): Effect.fn.Return<SshAskpassHelperDescriptor, never, Path.Path> {
    const platform = yield* HostProcess.Platform;
    const path = yield* Path.Path;
    const directory = input.directory;

    if (platform === "win32") {
      const helperPath = joinSshAskpassPath(directory, "ssh-askpass.cjs", platform);
      return {
        helperPath,
        files: [
          { path: helperPath, contents: ASKPASS_WINDOWS_NODE_SCRIPT },
          {
            path: joinSshAskpassPath(directory, "ssh-askpass.sh", platform),
            contents: ASKPASS_POSIX_SCRIPT,
          },
        ],
      };
    }

    return {
      helperPath: path.join(directory, "ssh-askpass.sh"),
      files: [
        {
          path: path.join(directory, "ssh-askpass.sh"),
          contents: ASKPASS_POSIX_SCRIPT,
          mode: 0o700,
        },
      ],
    };
  },
);

const ensureSshAskpassHelpers = Effect.fn("ssh/auth.ensureSshAskpassHelpers")(function* (input: {
  readonly directory: string;
}): Effect.fn.Return<string, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const descriptor = yield* buildSshAskpassHelperDescriptor(input);
  const platform = yield* HostProcess.Platform;

  yield* fs.makeDirectory(path.dirname(descriptor.helperPath), { recursive: true });

  for (const file of descriptor.files) {
    const existing = yield* fs.exists(file.path);
    const current = existing ? yield* fs.readFileString(file.path) : null;
    if (current !== file.contents) {
      yield* fs.writeFileString(file.path, file.contents);
    }
    if (file.mode !== undefined && platform !== "win32") {
      yield* fs.chmod(file.path, file.mode);
    }
  }

  return descriptor.helperPath;
});

// Keep setup serialized through cancellation so writes finish before another command uses the helper.
let defaultSshAskpassRuntimeDirectory: string | undefined;
const defaultSshAskpassLock = Semaphore.makeUnsafe(1);

const ensureDefaultSshAskpassHelpers = Effect.fn("ssh/auth.ensureDefaultSshAskpassHelpers")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userId = yield* HostProcess.UserId;
    let runtimeDirectory = defaultSshAskpassRuntimeDirectory;
    if (runtimeDirectory !== undefined) {
      const cached = runtimeDirectory;
      const reusable = yield* Effect.all([fs.realPath(cached), fs.stat(cached)]).pipe(
        Effect.map(
          ([resolved, info]) =>
            resolved === cached &&
            info.type === "Directory" &&
            (userId === undefined || Option.getOrUndefined(info.uid) === userId),
        ),
        Effect.orElseSucceed(() => false),
      );
      if (!reusable) {
        runtimeDirectory = undefined;
      }
    }
    runtimeDirectory ??= yield* fs.realPath(
      yield* fs.makeTempDirectory({ prefix: "t3code-ssh-runtime-" }),
    );
    const helperPath = yield* ensureSshAskpassHelpers({
      directory: path.join(runtimeDirectory, SSH_ASKPASS_DIR_NAME),
    });
    defaultSshAskpassRuntimeDirectory = runtimeDirectory;
    return helperPath;
  },
  (effect) => defaultSshAskpassLock.withPermit(Effect.uninterruptible(effect)),
);

// Anything that does not identify as Win32-OpenSSH gets the shell helper. A client that cannot
// start it fails to authenticate.
const isWin32OpenSsh = Effect.fn("ssh/auth.isWin32OpenSsh")(
  function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(ChildProcess.make("ssh.exe", ["-V"]));
    const banner = yield* handle.stderr.pipe(Stream.decodeText(), Stream.mkString);
    return banner.includes("OpenSSH_for_Windows");
  },
  Effect.scoped,
  Effect.orElseSucceed(() => false),
);

export const buildSshChildEnvironment = Effect.fn("ssh/auth.buildSshChildEnvironment")(function* (
  input: SshChildEnvironmentOptions = {},
): Effect.fn.Return<
  NodeJS.ProcessEnv,
  PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const baseEnv = { ...input.baseEnv };
  if (!input.interactiveAuth) {
    return baseEnv;
  }

  const platform = yield* HostProcess.Platform;
  const hostDisplay = input.baseEnv
    ? input.baseEnv.DISPLAY
    : yield* Config.String("DISPLAY").pipe(
        Config.option,
        Effect.orElseSucceed(() => Option.none<string>()),
        Effect.map(Option.getOrUndefined),
      );
  const helperPath =
    input.askpassDirectory === undefined
      ? yield* ensureDefaultSshAskpassHelpers()
      : yield* ensureSshAskpassHelpers({ directory: input.askpassDirectory });

  const authSecretEnv =
    input.authSecret === undefined ? {} : { T3_SSH_AUTH_SECRET: input.authSecret ?? "" };

  if (platform === "win32") {
    if (!(yield* isWin32OpenSsh())) {
      return {
        ...baseEnv,
        SSH_ASKPASS: helperPath.replace(/\.cjs$/u, ".sh"),
        SSH_ASKPASS_REQUIRE: "force",
        ...authSecretEnv,
      };
    }
    // Win32-OpenSSH uses a value that starts with a quote as the command line as written; an
    // unquoted one is split after a lower-case ".exe" only. The single-executable t3.exe ignores
    // a script argument, so it loads the helper through NODE_OPTIONS instead.
    const execPath = yield* HostProcess.ExecutablePath;
    const preload = (yield* HostProcess.IsExecutable)
      ? { NODE_OPTIONS: `--require "${helperPath.replaceAll("\\", "/")}"` }
      : {};
    return {
      ...baseEnv,
      SSH_ASKPASS: `"${execPath}" "${helperPath}"`,
      SSH_ASKPASS_REQUIRE: "force",
      ELECTRON_RUN_AS_NODE: "1",
      ...preload,
      ...authSecretEnv,
    };
  }

  return {
    ...baseEnv,
    SSH_ASKPASS: helperPath,
    SSH_ASKPASS_REQUIRE: "force",
    ...authSecretEnv,
    ...(baseEnv.DISPLAY || hostDisplay ? {} : { DISPLAY: "t3code" }),
  };
});

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-keyex|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}

// A local agent signing failure cannot be remedied by the remote account password.
export function isSshAgentSigningFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /sign_and_send_pubkey: signing failed(?: for [^\n]* from agent:|: (?:agent refused operation|communication with agent failed))/u.test(
    message,
  );
}
