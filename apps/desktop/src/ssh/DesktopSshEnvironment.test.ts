import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import { MoshControlManager, MoshSessionStartError } from "@t3tools/mosh";
import * as SshTunnel from "@t3tools/ssh/tunnel";
import { SshPasswordPromptError } from "@t3tools/ssh/errors";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as DesktopSshEnvironment from "./DesktopSshEnvironment.ts";
import * as DesktopSshPasswordPrompts from "./DesktopSshPasswordPrompts.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-env-test-" });
  });
}

describe("sshEnvironment", () => {
  it("keeps prompt presentation diagnostics distinct from the legacy wrapper message", () => {
    const cause = new DesktopSshPasswordPrompts.DesktopSshPromptPresentationError({
      requestId: "prompt-1",
      destination: "devbox",
      operation: "send-prompt-request",
      cause: new Error("renderer send failed"),
    });

    assert.equal(cause.message, "Failed to present SSH password prompt for devbox.");
    assert.equal(
      DesktopSshEnvironment.toSshPasswordPromptError(cause).message,
      "T3 Code window is not available for SSH authentication.",
    );
  });

  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    assert.equal(
      DesktopSshEnvironment.isDesktopSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
          cause: new DesktopSshPasswordPrompts.DesktopSshPromptTimedOutError({
            requestId: "prompt-1",
            destination: "devbox",
          }),
        }),
      ),
      true,
    );
  });

  it.effect("wires desktop host discovery through the ssh package runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        [
          "Host staging",
          "  HostName staging.example.com",
          "Host *",
          "  ServerAliveInterval 30",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const sshEnvironment = yield* DesktopSshEnvironment.DesktopSshEnvironment;
      const hosts = yield* sshEnvironment.discoverHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "staging",
          hostname: "staging",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(
      Effect.provide(
        DesktopSshEnvironment.layer().pipe(
          Layer.provideMerge(
            Layer.succeed(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
              request: () => Effect.die("unexpected password prompt request"),
              resolve: () => Effect.die("unexpected password prompt resolution"),
            }),
          ),
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(NodeHttpClient.layerUndici),
          Layer.provideMerge(NetService.layer),
        ),
      ),
      Effect.scoped,
    ),
  );

  it.effect("keeps the Tailscale data plane usable when Mosh recovery fails", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.tail.example.ts.net",
      username: "emil",
      port: 22,
    } as const;
    const bootstrap = {
      target,
      httpBaseUrl: "https://devbox.tail.example.ts.net",
      wsBaseUrl: "wss://devbox.tail.example.ts.net",
      pairingToken: null,
      remotePort: 49_123,
      remoteServerKind: "managed",
      accessMode: "tailscale",
      tailscale: {
        magicDnsName: "devbox.tail.example.ts.net",
        tailnetIpv4Addresses: ["100.64.0.10"],
        servePort: 443,
      },
    } as const;
    let ensureCount = 0;
    let moshEnsureCount = 0;
    const manager = SshTunnel.SshEnvironmentManager.of({
      authenticationOptions: () => Effect.succeed({ batchMode: "yes", interactiveAuth: false }),
      ensureEnvironment: () =>
        Effect.sync(() => {
          ensureCount += 1;
          return bootstrap;
        }),
      disconnectEnvironment: () => Effect.void,
    });
    const mosh = MoshControlManager.of({
      ensure: () =>
        Effect.suspend(() => {
          moshEnsureCount += 1;
          return Effect.fail(
            new MoshSessionStartError({
              command: ["mosh"],
              stderr: "simulated roaming transport loss",
            }),
          );
        }),
      disconnect: () => Effect.void,
      status: () => Effect.succeed(null),
    });

    return Effect.gen(function* () {
      const environment = yield* DesktopSshEnvironment.make;
      const reconnect = yield* environment.ensureEnvironment(target, {
        accessMode: "tailscale",
        requireMosh: false,
      });

      assert.strictEqual(reconnect, bootstrap);
      assert.equal(reconnect.wsBaseUrl, "wss://devbox.tail.example.ts.net");
      assert.equal(ensureCount, 1);
      assert.equal(moshEnsureCount, 1);
    }).pipe(
      Effect.provideService(SshTunnel.SshEnvironmentManager, manager),
      Effect.provideService(MoshControlManager, mosh),
      Effect.provideService(DesktopSshPasswordPrompts.DesktopSshPasswordPrompts, {
        request: () => Effect.die("unexpected password prompt request"),
        resolve: () => Effect.die("unexpected password prompt resolution"),
      }),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeHttpClient.layerUndici),
      Effect.provide(NetService.layer),
    );
  });
});
