// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalFetch:off - supervises an external CLI and its loopback health endpoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { CritOpenError, type CritOpenInput } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const READY =
  /(?:Started crit daemon at|Connected to crit daemon at) http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/;
const decodeCritStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ sessions: Schema.Array(Schema.Struct({ port: Schema.Number })) }),
  ),
);
const decodeTailscaleStatus = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      BackendState: Schema.String,
      Self: Schema.optional(
        Schema.NullOr(Schema.Struct({ DNSName: Schema.optional(Schema.String) })),
      ),
    }),
  ),
);
const TailscaleListeners = Schema.Struct({
  TCP: Schema.optional(Schema.Record(Schema.String, Schema.Struct({}))),
});
const decodeTailscaleServe = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      ...TailscaleListeners.fields,
      Foreground: Schema.optional(Schema.Record(Schema.String, TailscaleListeners)),
    }),
  ),
);
const FORWARD_START_TIMEOUT_MS = 10_000;
const BROWSER_START_TIMEOUT_MS = 60_000;
const BROWSER_CHECK_INTERVAL_MS = 2_000;
const MAX_REVIEW_LIFETIME_MS = 60 * 60 * 1_000;
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

class TailscaleServePermissionError extends Schema.TaggedError<TailscaleServePermissionError>()(
  "TailscaleServePermissionError",
  {},
) {
  override get message(): string {
    return "Tailscale needs permission to publish the Crit review.";
  }
}

const isTailscaleServePermissionError = Schema.is(TailscaleServePermissionError);

async function tailscaleTarget(command: string): Promise<{
  readonly hostname: string;
  readonly occupiedPorts: ReadonlySet<number>;
}> {
  const status = decodeTailscaleStatus(
    (await execFile(command, ["status", "--json"], { timeout: FORWARD_START_TIMEOUT_MS })).stdout,
  );
  const hostname = status.Self?.DNSName?.replace(/\.$/, "") ?? "";
  if (status.BackendState !== "Running" || !hostname.endsWith(".ts.net")) {
    throw new Error("Tailscale must be connected to open this Crit review remotely.");
  }
  const config = decodeTailscaleServe(
    (await execFile(command, ["serve", "status", "--json"], { timeout: FORWARD_START_TIMEOUT_MS }))
      .stdout,
  );
  return {
    hostname,
    occupiedPorts: new Set(
      [config, ...Object.values(config.Foreground ?? {})].flatMap((entry) =>
        Object.keys(entry.TCP ?? {}).map(Number),
      ),
    ),
  };
}

async function unusedTailnetPort(
  occupiedPorts: ReadonlySet<number>,
  allocatedPorts: ReadonlySet<number>,
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const server = NodeNet.createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Could not reserve a port for the Crit review."));
          return;
        }
        resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (!occupiedPorts.has(port) && !allocatedPorts.has(port)) return port;
  }
  throw new Error("Could not find an unused Tailscale port for the Crit review.");
}

function waitForTailscaleForward(child: NodeChildProcess.ChildProcess, url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timeout = setTimeout(
      () => finish(new Error("Tailscale did not forward the Crit review in time.")),
      FORWARD_START_TIMEOUT_MS,
    );
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("close", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk: Buffer): void => {
      output = (output + chunk.toString()).slice(-4_096);
      if (output.includes("Available within your tailnet:") && output.includes(url)) finish();
    };
    const onStderr = (chunk: Buffer): void => {
      stderr = (stderr + chunk.toString()).slice(-4_096);
    };
    const onError = (): void => finish(new Error("Could not start Tailscale Serve for Crit."));
    const onClose = (): void =>
      finish(
        /permission denied|access denied|must be root|operation not permitted/i.test(stderr)
          ? new TailscaleServePermissionError({})
          : new Error(
              "Tailscale Serve exited before forwarding Crit. Check Tailscale permissions.",
            ),
      );
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

async function critArgs(input: CritOpenInput): Promise<string[]> {
  switch (input.scope.kind) {
    case "working-tree":
      return ["--base-branch", "HEAD"];
    case "branch": {
      const { stdout } = await execFile("git", ["merge-base", "--", input.scope.baseRef, "HEAD"], {
        cwd: input.cwd,
      });
      return ["--range", `${stdout.trim()}..HEAD`];
    }
    case "pull-request": {
      if (input.scope.commit) {
        const commit = input.scope.commit;
        try {
          await execFile("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: input.cwd });
        } catch {
          const ref =
            input.scope.provider === "github"
              ? `refs/pull/${input.scope.number}/head`
              : `refs/merge-requests/${input.scope.number}/head`;
          await execFile("git", ["fetch", "--quiet", "--no-tags", "origin", ref], {
            cwd: input.cwd,
            timeout: 30_000,
          });
          await execFile("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: input.cwd });
        }
        return ["--range", `${commit}^..${commit}`];
      }
      return input.scope.provider === "github"
        ? ["--pr", input.scope.url]
        : ["--mr", input.scope.url, "--remote"];
    }
    case "turn": {
      const fromRef =
        input.scope.fromRef ??
        (input.scope.fromTurnCount === 0 && /\/(?:ordinal|turn)\/\d+$/.test(input.scope.toRef)
          ? input.scope.toRef.replace(/\d+$/, "0")
          : null);
      if (fromRef === null) {
        throw new Error("The previous turn checkpoint is unavailable.");
      }
      return ["--range", `${fromRef}..${input.scope.toRef}`];
    }
  }
}

interface ManagedReview {
  stop: () => Promise<void>;
}

/** Isolate Crit's daemon registry per launch while leaving reviews in Crit's normal data root. */
export function createCritManager(
  options: {
    readonly command?: string;
    readonly tailscaleCommand?: string;
    readonly sudoCommand?: string;
    readonly outputDir?: string;
    readonly browserCheckIntervalMs?: number;
    readonly browserDisconnectGraceMs?: number;
    readonly maxReviewLifetimeMs?: number;
  } = {},
) {
  const command = options.command ?? "crit";
  const tailscaleCommand = options.tailscaleCommand ?? "tailscale";
  const sudoCommand = options.sudoCommand ?? "sudo";
  const outputDir = options.outputDir ?? NodePath.join(NodeOS.homedir(), ".crit");
  const isWindows = HostProcess.Platform.defaultValue() === "win32";
  const reviews = new Set<ManagedReview>();
  const allocatedTailnetPorts = new Set<number>();

  const launch = async (input: CritOpenInput, forwarded: boolean) => {
    if (input.portlessPort !== undefined) {
      throw new Error("Update the desktop app to open SSH reviews with standard port forwarding.");
    }
    const tailnet = input.tailscale ? await tailscaleTarget(tailscaleCommand) : null;
    const args = await critArgs(input);
    let githubRepository: string | undefined;
    if (input.scope.kind === "pull-request" && input.scope.provider === "github") {
      const url = new URL(input.scope.url);
      const repository = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
      if (
        url.protocol !== "https:" ||
        !repository ||
        Number(repository[3]) !== input.scope.number
      ) {
        throw new Error("Crit needs a GitHub pull request URL for this review.");
      }
      githubRepository = `${url.hostname}/${repository[1]}/${repository[2]}`;
    }
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-crit-"));
    const providerBin = NodePath.join(root, "bin");
    if (input.scope.kind === "pull-request" && !isWindows) {
      try {
        await NodeFSP.mkdir(providerBin);
        // The daemon keeps its own HOME; forge and git CLIs need the environment's normal login.
        for (const tool of ["gh", "glab", "git"]) {
          await NodeFSP.writeFile(
            NodePath.join(providerBin, tool),
            `#!/bin/sh\nHOME=${shellQuote(NodeOS.homedir())} USERPROFILE=${shellQuote(NodeOS.homedir())} PATH=${shellQuote(process.env.PATH ?? "")} exec ${tool} "$@"\n`,
            { mode: 0o755 },
          );
        }
      } catch (error) {
        await NodeFSP.rm(root, { recursive: true, force: true });
        throw error;
      }
    }
    let tailnetPort: number | null = null;
    try {
      if (tailnet) {
        tailnetPort = await unusedTailnetPort(tailnet.occupiedPorts, allocatedTailnetPorts);
        allocatedTailnetPorts.add(tailnetPort);
      }
    } catch (error) {
      await NodeFSP.rm(root, { recursive: true, force: true });
      throw error;
    }
    const reviewUrl = tailnet && tailnetPort ? `https://${tailnet.hostname}:${tailnetPort}` : null;
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      ...(input.scope.kind === "pull-request" && !isWindows
        ? { PATH: `${providerBin}${NodePath.delimiter}${process.env.PATH ?? ""}` }
        : {}),
      ...(githubRepository ? { GH_REPO: githubRepository } : {}),
      CRIT_NO_INTEGRATION_CHECK: "1",
      CRIT_NO_UPDATE_CHECK: "1",
    };
    const child = NodeChildProcess.spawn(
      command,
      [
        "--host",
        "127.0.0.1",
        "--output",
        outputDir,
        ...(tailnetPort === null ? [] : ["--port", String(tailnetPort)]),
        ...(reviewUrl || forwarded ? ["--no-open"] : []),
        ...(reviewUrl ? ["--public-url", reviewUrl, "--allow-unauthenticated-network"] : []),
        ...args,
      ],
      {
        cwd: input.cwd,
        stdio: ["ignore", "ignore", "pipe"],
        env,
      },
    );
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    let lifetimeTimeout: ReturnType<typeof setTimeout> | undefined;
    let resolveExit: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    child.once("exit", resolveExit);
    child.once("error", resolveExit);
    let stopPromise: Promise<void> | undefined;
    let tailnetChild: NodeChildProcess.ChildProcess | undefined;
    let tailnetExited: Promise<void> | undefined;
    const review: ManagedReview = {
      stop: () => {
        stopPromise ??= (async () => {
          stopped = true;
          if (timer) clearInterval(timer);
          if (startupTimeout) clearTimeout(startupTimeout);
          if (lifetimeTimeout) clearTimeout(lifetimeTimeout);
          if (tailnetChild) {
            if (tailnetChild.exitCode === null && tailnetChild.signalCode === null) {
              tailnetChild.kill("SIGTERM");
            }
            await tailnetExited;
          }
          if (tailnetPort !== null) allocatedTailnetPorts.delete(tailnetPort);
          // Crit's session registry is confined to this launch's HOME, even if
          // its CLI has already exited without stopping the daemon.
          try {
            await execFile(command, ["stop", "--all"], { cwd: input.cwd, env, timeout: 5_000 });
          } catch {
            // A failed launch or approved review may have no daemon to stop.
          }
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
          await exited;
          await NodeFSP.rm(root, { recursive: true, force: true });
          reviews.delete(review);
        })();
        return stopPromise;
      },
    };
    reviews.add(review);

    try {
      const announcedPort = await new Promise<number | null>((resolve, reject) => {
        let stderr = "";
        const fail = (message: string): void => reject(new Error(message));
        startupTimeout = setTimeout(() => fail("Crit did not start a review in time."), 30_000);
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-4_096);
          const match = READY.exec(stderr);
          const publicReady =
            reviewUrl !== null &&
            (stderr.includes(`Started crit daemon at ${reviewUrl} (session `) ||
              stderr.includes(`Connected to crit daemon at ${reviewUrl} (session `));
          if (match || publicReady) {
            if (startupTimeout) clearTimeout(startupTimeout);
            resolve(match ? Number(match[1]) : null);
          }
        });
        child.once("error", (error) => fail(`Could not start crit: ${error.message}`));
        child.once("exit", () => fail(stderr.trim() || "Crit exited before opening a review."));
      });
      // With --public-url Crit announces the proxy URL; its isolated HOME has exactly one session.
      const port =
        announcedPort ??
        decodeCritStatus(
          (
            await execFile(command, ["status", "--json"], {
              cwd: input.cwd,
              env,
              timeout: 5_000,
            })
          ).stdout,
        ).sessions[0]?.port;
      if (!port || !Number.isInteger(port) || port > 65_535) {
        throw new Error("Could not determine Crit's listening port.");
      }
      if (tailnetPort !== null && reviewUrl !== null) {
        // Foreground Serve owns a separate session; exiting removes only this review's endpoint.
        const forwardArgs: string[] = [
          "serve",
          `--https=${tailnetPort}`,
          `http://127.0.0.1:${port}`,
        ];
        const startForward = async (elevated: boolean): Promise<void> => {
          const forward: NodeChildProcess.ChildProcess = NodeChildProcess.spawn(
            elevated ? sudoCommand : tailscaleCommand,
            elevated ? ["-n", "--", tailscaleCommand, ...forwardArgs] : forwardArgs,
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          tailnetChild = forward;
          tailnetExited = new Promise<void>((resolve) => {
            forward.once("exit", resolve);
            forward.once("error", resolve);
          });
          await waitForTailscaleForward(forward, reviewUrl);
        };
        try {
          await startForward(false);
        } catch (error) {
          if (!isTailscaleServePermissionError(error) || isWindows) throw error;
          // Existing file shares make even an operator's proxy-only config require sudo.
          try {
            await startForward(true);
          } catch {
            throw new Error(
              "Tailscale needs permission to forward Crit. Allow non-interactive sudo for tailscale or adjust the server's Tailscale permissions.",
            );
          }
        }
        void tailnetExited?.then(() => review.stop()).catch(() => undefined);
      }
      const started = Date.now();
      lifetimeTimeout = setTimeout(
        () => void review.stop().catch(() => undefined),
        options.maxReviewLifetimeMs ?? MAX_REVIEW_LIFETIME_MS,
      );
      let connected = false;
      let absentSince: number | null = null;
      let checking = false;
      timer = setInterval(() => {
        if (checking || stopped) return;
        checking = true;
        void (async () => {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
              signal: AbortSignal.timeout(1_000),
            });
            if (response.ok) {
              const health: unknown = await response.json();
              if (
                typeof health === "object" &&
                health !== null &&
                "status" in health &&
                health.status === "ok" &&
                "browser_clients" in health &&
                typeof health.browser_clients === "boolean"
              ) {
                if (health.browser_clients) {
                  connected = true;
                  absentSince = null;
                } else if (absentSince === null) {
                  absentSince = Date.now();
                }
              }
            }
          } catch {
            // A transient failed health check is not proof the browser closed.
          } finally {
            checking = false;
          }
          if (
            (connected &&
              absentSince !== null &&
              Date.now() - absentSince >= (options.browserDisconnectGraceMs ?? 4_000)) ||
            (!connected && Date.now() - started >= BROWSER_START_TIMEOUT_MS)
          )
            void review.stop().catch(() => undefined);
        })();
      }, options.browserCheckIntervalMs ?? BROWSER_CHECK_INTERVAL_MS);
      void exited.then(() => review.stop()).catch(() => undefined);
      return { port, reviewUrl, exited, stop: review.stop };
    } catch (error) {
      await review.stop();
      throw error;
    }
  };

  const start = (input: CritOpenInput, forwarded: boolean) =>
    Effect.tryPromise({
      try: () => launch(input, forwarded),
      catch: (cause) =>
        new CritOpenError({
          message: cause instanceof Error ? cause.message : "Could not open Crit.",
        }),
    });

  return {
    open: (input: CritOpenInput) =>
      start(input, false).pipe(Effect.map((review) => review.reviewUrl)),
    forward: (input: CritOpenInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const review = yield* Effect.acquireRelease(start(input, true), (review) =>
            Effect.promise(review.stop),
          );
          // The review and desktop listener share the lifetime of this RPC stream.
          return Stream.concat(
            Stream.succeed(review.port),
            Stream.fromEffectDrain(Effect.promise(() => review.exited)),
          );
        }),
      ),
    dispose: async (): Promise<void> => {
      await Promise.all([...reviews].map((review) => review.stop()));
    },
  };
}

export class CritManager extends Context.Service<
  CritManager,
  ReturnType<typeof createCritManager>
>()("t3/process/CritManager") {}

export const layer = Layer.effect(
  CritManager,
  Effect.acquireRelease(Effect.sync(createCritManager), (manager) =>
    Effect.promise(() => manager.dispose()),
  ),
);
