import type { ManagedPolicyDocument } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import * as EnvironmentAuthPolicy from "../auth/EnvironmentAuthPolicy.ts";
import * as ManagedLimits from "./managedLimits.ts";
import * as ManagedPolicy from "./ManagedPolicy.ts";

const policy = (limits?: ManagedPolicyDocument["limits"]) => ({
  document: {
    schemaVersion: 1 as const,
    organization: "Example Corp",
    ...(limits === undefined ? {} : { limits }),
  },
});

const desktopAndLocal = policy({ clients: ["desktop", "local-browser"] });

it.effect("refuses to listen on a non-loopback host when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "remote-reachable",
      host: "0.0.0.0",
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.equal(
      error.message,
      "Example Corp's policy does not allow remote clients, so the server cannot listen on 0.0.0.0.",
    );
  }),
);

it.effect("binds only the loopback address it approved when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const bind = (
      host: string | undefined,
      policy: { readonly document: ManagedPolicyDocument | undefined } = desktopAndLocal,
    ) =>
      ManagedLimits.checkServerReachability(policy, {
        authPolicy: EnvironmentAuthPolicy.resolveServerAuthPolicy({ mode: "web", host }),
        host,
        tailscaleServeEnabled: false,
      });
    // Node listens on every interface for an empty host, and a name resolves through DNS.
    for (const host of ["", "127.office.example", "127.0.0.1e0", "0.0.0.0"]) {
      const error = yield* bind(host).pipe(Effect.flip);
      assert.include(error.message, "does not allow remote clients", host);
    }
    for (const [host, address] of [
      [undefined, "127.0.0.1"],
      ["localhost", "127.0.0.1"],
      ["127.0.0.2", "127.0.0.2"],
      ["[::1]", "::1"],
    ] as const) {
      assert.equal(yield* bind(host), address);
    }
    assert.equal(yield* bind("localhost", { document: undefined }), "localhost");
    assert.equal(yield* bind(undefined, { document: undefined }), "127.0.0.1");
  }),
);

it.effect("refuses Tailscale Serve when remote clients are not allowed", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(desktopAndLocal, {
      authPolicy: "loopback-browser",
      host: undefined,
      tailscaleServeEnabled: true,
    }).pipe(Effect.flip);
    assert.include(error.message, "Tailscale Serve");
  }),
);

it.effect("refuses an auth policy the clients list leaves out", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy({ clients: ["desktop"] }), {
      authPolicy: "loopback-browser",
      host: undefined,
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.equal(error.message, "Example Corp's policy does not allow browsers on this machine.");
  }),
);

it.effect("refuses unsafe-no-auth under any policy file, even one without limits", () =>
  Effect.gen(function* () {
    const error = yield* ManagedLimits.checkServerReachability(policy(), {
      authPolicy: "unsafe-no-auth",
      host: undefined,
      tailscaleServeEnabled: false,
    }).pipe(Effect.flip);
    assert.include(error.message, "without authentication");
    assert.isTrue(ManagedLimits.allowsAuthPolicy({ document: undefined }, "unsafe-no-auth"));
  }),
);

it.effect("allows the clients the policy lists", () =>
  ManagedLimits.checkServerReachability(policy({ clients: ["remote"] }), {
    authPolicy: "remote-reachable",
    host: "0.0.0.0",
    tailscaleServeEnabled: true,
  }),
);

it.effect("tells clients Connect is off when the policy leaves out remote clients", () =>
  Effect.gen(function* () {
    const managed = yield* ManagedPolicy.fromDocument("/test/policy.json", {
      ...desktopAndLocal.document,
    });
    assert.deepEqual(managed.summary?.limits, {
      clients: ["desktop", "local-browser"],
      connect: false,
    });
    assert.isTrue(ManagedLimits.allowsConnect(policy({ clients: ["remote"] })));
    assert.isFalse(ManagedLimits.allowsConnect(policy({ connect: false })));
  }),
);

it.effect(
  "turns off only the Tailscale Serve routes that forward here, and refuses to start if one stays",
  () => {
    type Web = Record<string, Record<string, string>>;
    interface Answers {
      /** Serve handlers by host:port, then mount, to proxy target. */
      readonly web?: Web;
      readonly status?: {
        readonly stdout: string;
        readonly exitCode: number;
        readonly stderr?: string;
      };
      readonly offExitCode?: number;
      /** `off` exits as told but leaves the config alone. */
      readonly offIgnored?: boolean;
    }
    // Acts as the real CLI: `serve status --json` prints the config, and `serve --https=<port> off`
    // drops every handler on that port unless `--set-path` names one (serve_v2.go removeWebServe).
    const close = (answers: Answers, offCalls: Array<ReadonlyArray<string>> = []) => {
      const web: Web = answers.web ?? {
        "box.tailnet.ts.net:443": { "/": "http://127.0.0.1:3773" },
      };
      return ManagedLimits.closeTailscaleServeTo(desktopAndLocal, 3773).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
            const isStatus = args.includes("status");
            if (!isStatus) {
              offCalls.push(args);
              const port = args.find((arg) => arg.startsWith("--https="))?.slice(8);
              const mount = args.find((arg) => arg.startsWith("--set-path="))?.slice(11);
              const site = Object.entries(web).find(([hostPort]) => hostPort.endsWith(`:${port}`));
              if (site !== undefined && answers.offIgnored !== true) {
                for (const handler of Object.keys(site[1])) {
                  if (mount === undefined || mount === handler) delete site[1][handler];
                }
              }
            }
            const status = answers.status ?? {
              stdout: JSON.stringify({
                Web: Object.fromEntries(
                  Object.entries(web).map(([hostPort, handlers]) => [
                    hostPort,
                    {
                      Handlers: Object.fromEntries(
                        Object.entries(handlers).map(([mount, proxy]) => [mount, { Proxy: proxy }]),
                      ),
                    },
                  ]),
                ),
              }),
              exitCode: 0,
            };
            const text = (value: string | undefined) =>
              value === undefined ? Stream.empty : Stream.make(new TextEncoder().encode(value));
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(
                  ChildProcessSpawner.ExitCode(
                    isStatus ? status.exitCode : (answers.offExitCode ?? 0),
                  ),
                ),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: isStatus ? text(status.stdout) : Stream.empty,
                stderr: isStatus ? text(status.stderr) : Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
      );
    };
    return Effect.gen(function* () {
      // A route that shares the port with this server's stays.
      for (const mount of ["/t3", "/"]) {
        const web: Web = {
          "box.tailnet.ts.net:443": {
            [mount]: "http://127.0.0.1:3773",
            "/dashboard": "http://127.0.0.1:9000",
          },
        };
        const offCalls: Array<ReadonlyArray<string>> = [];
        yield* close({ web }, offCalls);
        assert.deepEqual(web, {
          "box.tailnet.ts.net:443": { "/dashboard": "http://127.0.0.1:9000" },
        });
        assert.deepEqual(offCalls, [["serve", "--https=443", `--set-path=${mount}`, "off"]]);
      }
      // Only a fresh read confirms the route is gone, whatever `off` exits with.
      for (const answers of [{ offIgnored: true }, { offIgnored: true, offExitCode: 1 }]) {
        const stuck = yield* close(answers).pipe(Effect.flip);
        assert.include(
          stuck.message,
          'Tailscale Serve forwards port 443 at / here; turn it off with "tailscale serve --https=443 --set-path=/ off"',
        );
      }
      // An answer that cannot be read might hide a mapping, so the server does not start.
      const dialFailure = (reason: string) =>
        `Failed to connect to local Tailscale daemon for /localapi/v0/serve-config; not running? Error: dial unix /var/run/tailscale/tailscaled.sock: connect: ${reason}`;
      for (const status of [
        { stdout: "", exitCode: 1, stderr: "something unexpected" },
        { stdout: "not json", exitCode: 0 },
        { stdout: "", exitCode: 1, stderr: "Access denied: serve config denied" },
        { stdout: "", exitCode: 1, stderr: dialFailure("permission denied") },
      ]) {
        const unread = yield* close({ status }).pipe(Effect.flip);
        assert.include(unread.message, "does not start until Tailscale Serve can be checked");
      }
      // Tailscale down, logged out, or not installed forwards nothing now.
      for (const stderr of [
        dialFailure("connection refused"),
        "NeedsLogin: not logged in",
        String.raw`Get "http://local-tailscaled.sock/localapi/v0/serve-config": open \\.\pipe\ProtectedPrefix\Administrators\Tailscale\tailscaled: The system cannot find the file specified.`,
      ]) {
        yield* close({ status: { stdout: "", exitCode: 1, stderr } });
      }
      const spawnFailing = (tag: "NotFound" | "PermissionDenied") =>
        ManagedLimits.closeTailscaleServeTo(desktopAndLocal, 3773).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.fail(
                PlatformError.systemError({ _tag: tag, module: "ChildProcess", method: "spawn" }),
              ),
            ),
          ),
        );
      yield* spawnFailing("NotFound");
      // Node throws this instead when PATH ends in a file.
      yield* ManagedLimits.closeTailscaleServeTo(desktopAndLocal, 3773).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.die(Object.assign(new Error("spawn tailscale ENOTDIR"), { code: "ENOTDIR" })),
          ),
        ),
      );
      // A CLI that is there but will not run might still front a daemon with a mapping.
      yield* spawnFailing("PermissionDenied").pipe(Effect.flip);
    });
  },
);
