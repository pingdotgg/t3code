// @effect-diagnostics nodeBuiltinImport:off -- Executes the generated SSH setup shell against a real temporary home.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NetService from "@t3tools/shared/Net";
import * as SshAuth from "@t3tools/ssh/auth";
import { SshEnvironmentManager } from "@t3tools/ssh/tunnel";
import {
  EnvironmentId,
  ManagedCloudSandboxResourceId,
  type ExecutionEnvironmentDescriptor,
} from "@t3tools/contracts";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import * as ServerConfig from "../config.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { buildRemoteT3RunnerScript } from "@t3tools/ssh/tunnel";
import packageJson from "../../package.json" with { type: "json" };
import {
  cloudSandboxCliRunner,
  cloudSandboxSetupPayload,
  cloudSandboxSourceProbe,
  make,
} from "./CloudSandboxTransport.ts";

it("passes the source health probe through SSH's remote shell without losing curl arguments", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-probe-"));
  try {
    NodeFS.writeFileSync(
      NodePath.join(directory, "curl"),
      '#!/bin/sh\n[ "$#" = 4 ] && [ "$4" = "http://127.0.0.1:47773/.well-known/t3/environment" ]\n',
      { mode: 0o700 },
    );
    const result = NodeChildProcess.spawnSync(
      "sh",
      ["-c", cloudSandboxSourceProbe.remoteCommandArgs.join(" ")],
      {
        input: "stdin" in cloudSandboxSourceProbe ? cloudSandboxSourceProbe.stdin : undefined,
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
      },
    );
    expect(result.status).toBe(0);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

it.effect("bootstraps the matching server release through the configured mirror", () =>
  Effect.gen(function* () {
    const runner = yield* cloudSandboxCliRunner;
    const script = buildRemoteT3RunnerScript(runner);
    expect(script).toContain(`T3_ARCHIVE_VERSION='${packageJson.version}'`);
    expect(script).toContain("T3_RELEASE_BASE_URL='https://releases.example.test'");
  }).pipe(
    Effect.provideService(HostProcess.Environment, {
      T3CODE_RELEASE_BASE_URL: "https://releases.example.test",
    }),
  ),
);

it("seeds the actual setup payload only into an authorized fresh child home", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-setup-"));
  try {
    const input = {
      enableLinkedEnvironments: true,
      parentSandboxId: "parent",
      expectedEnvironmentId: null,
    };
    const run = (
      hash: string,
      parentHash: string | null,
      settings: Parameters<typeof cloudSandboxSetupPayload>[0] = input,
    ) => {
      const result = NodeChildProcess.spawnSync("sh", ["-s"], {
        input: cloudSandboxSetupPayload(settings, hash, parentHash, "{}"),
        env: { ...process.env, HOME: home },
      });
      expect(result.status).toBe(0);
    };
    run("child", "parent");
    const settingsPath = NodePath.join(home, ".t3/environments/child/userdata/settings.json");
    expect(JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))).toEqual({
      linkedEnvironmentsEnabled: true,
    });
    NodeFS.writeFileSync(settingsPath, '{"linkedEnvironmentsEnabled":false}');
    run("child", "parent");
    expect(JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"))).toEqual({
      linkedEnvironmentsEnabled: false,
    });
    run("fresh", null, { ...input, parentSandboxId: null });
    expect(
      JSON.parse(
        NodeFS.readFileSync(
          NodePath.join(home, ".t3/environments/fresh/userdata/settings.json"),
          "utf8",
        ),
      ),
    ).toEqual({ linkedEnvironmentsEnabled: true });
    run("attached", null, { ...input, parentSandboxId: null, enableLinkedEnvironments: false });
    expect(() =>
      NodeFS.readFileSync(NodePath.join(home, ".t3/environments/attached/userdata/settings.json")),
    ).toThrow();
    NodeFS.mkdirSync(NodePath.join(home, ".t3/environments/disabled"), { recursive: true });
    run("disabled", "parent", { ...input, enableLinkedEnvironments: false });
    expect(() =>
      NodeFS.readFileSync(NodePath.join(home, ".t3/environments/disabled/userdata/settings.json")),
    ).toThrow();
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it("empties a fork's parent home but keeps its worktrees", () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-fork-"));
  try {
    const parent = NodePath.join(home, ".t3/environments/parent");
    const write = (relative: string, contents: string) => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(parent, relative)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(parent, relative), contents);
    };
    write("secrets/x", "secret");
    write("userdata/y", "state");
    write("worktrees/w/file", "checkout");
    const result = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: cloudSandboxSetupPayload(
        { enableLinkedEnvironments: false, parentSandboxId: "parent", expectedEnvironmentId: null },
        "child",
        "parent",
        "{}",
      ),
      env: { ...process.env, HOME: home },
    });
    expect(result.status).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(parent, "secrets"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(parent, "userdata"))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(parent, "worktrees/w/file"), "utf8")).toBe("checkout");
  } finally {
    NodeFS.rmSync(home, { recursive: true, force: true });
  }
});

it.effect("returns an unconsumed peer credential after exchanging the transport credential", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const directory = `${config.baseDir}/cloud-sandbox-ssh`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(`${directory}/id_ed25519`, "fixture-private-key");
    yield* fs.writeFileString(`${directory}/id_ed25519.pub`, "ssh-ed25519 fixture-public-key");
    yield* fs.writeFileString(
      config.serverRuntimeStatePath,
      JSON.stringify({
        version: 1,
        pid: 1,
        port: 13773,
        origin: "http://127.0.0.1:13773",
        startedAt: "2026-01-01T00:00:00Z",
      }),
    );
    let issued = 0;
    const available = new Set<string>();
    const manager = Layer.mock(SshEnvironmentManager)({
      ensureEnvironment: (target) =>
        Effect.sync(() => {
          const pairingToken = `pairing-${++issued}`;
          available.add(pairingToken);
          return {
            target,
            pairingToken,
            httpBaseUrl: "http://child.test",
            wsBaseUrl: "ws://child.test/ws",
          };
        }),
      releaseEnvironment: () => Effect.void,
    });
    const client = HttpClient.make((request) => {
      let response: Response;
      if (request.url.endsWith("/oauth/token")) {
        if (request.body._tag !== "Uint8Array")
          return Effect.die("Expected encoded token exchange");
        const form = new URLSearchParams(new TextDecoder().decode(request.body.body));
        const token = form.get("subject_token");
        if (token === null || !available.delete(token))
          return Effect.die("A bootstrap credential can only be exchanged once");
        response = Response.json({
          access_token: "transport-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read orchestration:operate",
        });
      } else if (request.url.endsWith("/.well-known/t3/environment")) {
        response = Response.json({
          environmentId: EnvironmentId.make("child"),
          label: "Child",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true, mcpModeLimitHeader: true, linkFence: true },
        } satisfies ExecutionEnvironmentDescriptor);
      } else if (request.url.endsWith("/sshkey")) {
        response = Response.json({
          machineIp: "192.0.2.1",
          sshEndpoint: null,
          sshUser: "root",
          hostKey: "ssh-ed25519 fixture",
        });
      } else {
        response = Response.json({
          ok: true,
          sandbox: { id: "bx_23456789", name: "test", state: "idle" },
        });
      }
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const spawnedArgs: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (command._tag === "StandardCommand") {
        spawnedArgs.push(command.args.map(String));
      }
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      );
    });
    const transport = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          manager,
          SshAuth.SshPasswordPrompt.disabledLayer,
          Layer.mock(NetService.NetService)({}),
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    const connected = yield* transport.connect({
      resourceId: "fresh",
      driverKind: "boat",
      apiKey: "fixture",
      sandboxId: "bx_23456789",
      parentSandboxId: null,
      expectedEnvironmentId: null,
      allowResume: true,
      enableLinkedEnvironments: true,
      context: {
        resourceId: ManagedCloudSandboxResourceId.make("fresh"),
        controllerEnvironmentId: EnvironmentId.make("controller"),
        controllerBaseUrl: "http://127.0.0.1:47773",
        grantToken: "fixture",
      },
    });
    expect(connected.bearerToken).toBe("transport-token");
    expect(available.has(connected.pairingToken)).toBe(true);
    const reverseArgs = spawnedArgs.find((args) => args.includes("-R"));
    expect(reverseArgs).toBeDefined();
    expect(reverseArgs?.find((arg) => arg.startsWith("BatchMode="))).toBe("BatchMode=yes");
    expect(reverseArgs).not.toContain("BatchMode=no");
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "cloud-transport-credential-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  ),
);

it.effect("rejects injected or malformed SSH host keys before writing known_hosts", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const directory = `${config.baseDir}/cloud-sandbox-ssh`;
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* fs.writeFileString(`${directory}/id_ed25519`, "fixture-private-key");
    yield* fs.writeFileString(`${directory}/id_ed25519.pub`, "ssh-ed25519 fixture-public-key");
    const manager = Layer.mock(SshEnvironmentManager)({
      ensureEnvironment: () => Effect.die("must not reach tunnel setup with injected hostKey"),
      releaseEnvironment: () => Effect.void,
    });
    let currentHostKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture\n@cert-authority * ssh-ed25519 EVIL";
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.endsWith("/sshkey")
            ? Response.json({
                machineIp: "192.0.2.1",
                sshEndpoint: null,
                sshUser: "root",
                hostKey: currentHostKey,
              })
            : Response.json({
                ok: true,
                sandbox: { id: "bx_23456789", name: "test", state: "idle" },
              }),
        ),
      ),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.die("must not spawn ssh with injected hostKey"),
    );
    const transport = yield* make.pipe(
      Effect.provide(
        Layer.mergeAll(
          manager,
          SshAuth.SshPasswordPrompt.disabledLayer,
          Layer.mock(NetService.NetService)({}),
          Layer.succeed(HttpClient.HttpClient, client),
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      ),
    );
    for (const badKey of [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture\n@cert-authority * ssh-ed25519 EVIL",
      "@cert-authority * ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture",
      "",
      "not-a-valid-host-key",
    ]) {
      currentHostKey = badKey;
      const result = yield* transport
        .connect({
          resourceId: "bad-host-key",
          driverKind: "boat",
          apiKey: "fixture",
          sandboxId: "bx_23456789",
          parentSandboxId: null,
          expectedEnvironmentId: null,
          allowResume: true,
          enableLinkedEnvironments: false,
          context: {
            resourceId: ManagedCloudSandboxResourceId.make("bad-host-key"),
            controllerEnvironmentId: EnvironmentId.make("controller"),
            controllerBaseUrl: "http://127.0.0.1:47773",
            grantToken: "fixture",
          },
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "cloud-transport-hostkey-" }).pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  ),
);
