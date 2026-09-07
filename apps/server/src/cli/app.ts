// @effect-diagnostics globalTimers:off -- The Node socket client owns its response deadline and clears it on every completion path.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import {
  DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
  DesktopAppActivationErrorCode,
  DesktopAppActivationResponse,
  type DesktopAppActivationPlatform,
  type DesktopAppActivationRequest,
} from "@t3tools/contracts";
import { resolveDesktopAppControlAddress } from "@t3tools/shared/desktopAppControl";
import {
  HostProcessPlatform,
  HostProcessUserId,
  HostProcessWorkingDirectory,
} from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command } from "effect/unstable/cli";

import { expandHomePath, resolveBaseDir } from "../os-jank.ts";
import { baseDirFlag } from "./config.ts";

const CLI_RESPONSE_TIMEOUT_MS = 17_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const isDesktopAppActivationResponse = Schema.is(DesktopAppActivationResponse);

export class DesktopAppSshUnsupportedError extends Schema.TaggedErrorClass<DesktopAppSshUnsupportedError>()(
  "DesktopAppSshUnsupportedError",
  {},
) {
  override get message(): string {
    return "`t3 app` only controls a desktop app on the same machine. It cannot run over SSH.";
  }
}

export class DesktopAppPlatformUnsupportedError extends Schema.TaggedErrorClass<DesktopAppPlatformUnsupportedError>()(
  "DesktopAppPlatformUnsupportedError",
  { platform: Schema.String },
) {
  override get message(): string {
    return `\`t3 app\` is not supported on ${this.platform}.`;
  }
}

export class DesktopAppUnreachableError extends Schema.TaggedErrorClass<DesktopAppUnreachableError>()(
  "DesktopAppUnreachableError",
  {
    candidateAddresses: Schema.Array(Schema.String),
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not reach the T3 Code desktop app. Start or update the desktop app on this machine, then run `t3 app` again. A running T3 Code server is not enough.";
  }
}

export class DesktopAppRequestFailedError extends Schema.TaggedErrorClass<DesktopAppRequestFailedError>()(
  "DesktopAppRequestFailedError",
  {
    code: DesktopAppActivationErrorCode,
    requestId: Schema.String,
    workspaceRoot: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `T3 Code could not open ${this.workspaceRoot} (${this.code}).`;
  }
}

function isDesktopPlatform(platform: NodeJS.Platform): platform is DesktopAppActivationPlatform {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

export function sendDesktopAppActivationRequest(input: {
  readonly address: string;
  readonly fallbackAddress?: string;
  readonly request: DesktopAppActivationRequest;
  readonly timeoutMs?: number;
}): Promise<DesktopAppActivationResponse> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection(input.address);
    socket.setEncoding("utf8");
    let buffer = "";
    let settled = false;
    let connected = false;

    const finish = (
      result:
        | { readonly type: "success"; readonly response: DesktopAppActivationResponse }
        | { readonly type: "failure"; readonly error: Error },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (result.type === "success") resolve(result.response);
      else reject(result.error);
    };

    const timeout = setTimeout(() => {
      finish({
        type: "failure",
        error: new Error("The desktop app did not respond in time."),
      });
    }, input.timeoutMs ?? CLI_RESPONSE_TIMEOUT_MS);

    socket.once("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(input.request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        finish({ type: "failure", error: new Error("The desktop app response is too large.") });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.slice(0, newline));
      } catch {
        finish({
          type: "failure",
          error: new Error("The desktop app response is not valid JSON."),
        });
        return;
      }
      if (!isDesktopAppActivationResponse(parsed)) {
        finish({ type: "failure", error: new Error("The desktop app response is invalid.") });
        return;
      }
      if (parsed.requestId !== input.request.requestId) {
        finish({
          type: "failure",
          error: new Error("The desktop app response did not match this request."),
        });
        return;
      }
      finish({ type: "success", response: parsed });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (
        !settled &&
        !connected &&
        input.fallbackAddress !== undefined &&
        (error.code === "ENOENT" || error.code === "ECONNREFUSED")
      ) {
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        resolve(
          sendDesktopAppActivationRequest({
            address: input.fallbackAddress,
            request: input.request,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          }),
        );
        return;
      }
      finish({ type: "failure", error });
    });
    socket.once("end", () => {
      finish({ type: "failure", error: new Error("The desktop app closed the connection.") });
    });
  });
}

const appEnvironment = Config.all({
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  sshConnection: Config.string("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.string("SSH_TTY").pipe(Config.option),
});

const runAppCommand = Effect.fn("cli.app")(function* (flags: {
  readonly baseDir: Option.Option<string>;
  readonly workspaceRoot: Option.Option<string>;
}) {
  const environment = yield* appEnvironment;
  const hostPlatform = yield* HostProcessPlatform;
  if (Option.isSome(environment.sshConnection) || Option.isSome(environment.sshTty)) {
    return yield* new DesktopAppSshUnsupportedError({});
  }
  if (!isDesktopPlatform(hostPlatform)) {
    return yield* new DesktopAppPlatformUnsupportedError({ platform: hostPlatform });
  }

  const path = yield* Path.Path;
  const configuredBaseDir = Option.getOrUndefined(flags.baseDir) ?? environment.t3Home;
  const baseDir = yield* resolveBaseDir(configuredBaseDir);
  const allowDevFallback = Option.isNone(flags.baseDir) && !environment.t3Home?.trim();
  const rawWorkspaceRoot =
    Option.getOrUndefined(flags.workspaceRoot) ?? (yield* HostProcessWorkingDirectory);
  const workspaceRoot = path.resolve(yield* expandHomePath(rawWorkspaceRoot));
  const userId = yield* HostProcessUserId;
  const resolveAddress = (stateSubdirectory: "userdata" | "dev") =>
    resolveDesktopAppControlAddress({
      stateDir: path.join(baseDir, stateSubdirectory),
      platform: hostPlatform,
      tempDir: NodeOS.tmpdir(),
      userId,
      joinPath: path.join,
    }).address;
  const request: DesktopAppActivationRequest = {
    version: DESKTOP_APP_ACTIVATION_PROTOCOL_VERSION,
    requestId: NodeCrypto.randomUUID(),
    type: "open-workspace",
    workspaceRoot,
    platform: hostPlatform,
  };
  const address = resolveAddress("userdata");
  const fallbackAddress = allowDevFallback ? resolveAddress("dev") : undefined;

  const response = yield* Effect.tryPromise({
    try: () =>
      sendDesktopAppActivationRequest({
        address,
        ...(fallbackAddress === undefined ? {} : { fallbackAddress }),
        request,
      }),
    catch: (cause) =>
      new DesktopAppUnreachableError({
        candidateAddresses: fallbackAddress === undefined ? [address] : [address, fallbackAddress],
        requestId: request.requestId,
        workspaceRoot,
        cause,
      }),
  });
  if (!response.ok) {
    return yield* new DesktopAppRequestFailedError({
      code: response.code,
      requestId: response.requestId,
      workspaceRoot,
      cause: response,
    });
  }

  yield* Console.log(`Opened ${workspaceRoot} in T3 Code.`);
});

export const appCommand = Command.make("app", {
  baseDir: baseDirFlag,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Project directory. Default: current directory."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Open a project in the running T3 Code desktop app."),
  Command.withHandler(runAppCommand),
);
