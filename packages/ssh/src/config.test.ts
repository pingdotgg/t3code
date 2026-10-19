import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSshHosts, resolveSshConfigIncludePattern } from "./config.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-test-" });
  });
}

describe("ssh config", () => {
  it.effect("discovers ssh config hosts across included files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d"), { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          "Host devbox",
          "  HostName devbox.example.com",
          "Host=equalsbox",
          "Include=config.d/*.conf",
          "",
        ].join("\n"),
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

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "devbox",
          hostname: "devbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "equalsbox",
          hostname: "equalsbox",
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
          alias: "ssh://bastion.example.com:2222",
          hostname: "bastion.example.com",
          username: null,
          port: 2222,
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
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps distinct known-host ports and rejects malformed explicit ports", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "host.example ssh-ed25519 AAAA",
          "[host.example]:2222 ssh-ed25519 AAAA",
          "[host.example]:2223 ssh-ed25519 AAAA",
          "[host.example]:2222 ssh-rsa BBBB",
          "[fe80::1%fixture0]:2200 ssh-ed25519 AAAA",
          "[invalid.example]:65536 ssh-ed25519 AAAA",
          "[invalid.example]:abc ssh-ed25519 AAAA",
          "invalid.example: ssh-ed25519 AAAA",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map(({ alias, hostname, port }) => ({ alias, hostname, port })),
        [
          { alias: "host.example", hostname: "host.example", port: null },
          { alias: "ssh://[fe80::1%fixture0]:2200", hostname: "fe80::1%fixture0", port: 2200 },
          { alias: "ssh://host.example:2222", hostname: "host.example", port: 2222 },
          { alias: "ssh://host.example:2223", hostname: "host.example", port: 2223 },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("parses known_hosts entries without returning hashed hosts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "github.com ssh-ed25519 AAAA",
          "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
          "|1|hashed|entry ssh-ed25519 CCCC",
          "@cert-authority authority.example.com,*.example.com ssh-ed25519 DDDD",
          "[ssh.example.com]:2200 ssh-ed25519 EEEE",
          "port.example.com:22 ssh-ed25519 HHHH",
          "::1 ssh-ed25519 FFFF",
          "2001:db8::1 ssh-ed25519 GGGG",
          "",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map(({ alias }) => alias),
        [
          "::1",
          "2001:db8::1",
          "authority.example.com",
          "github.com",
          "gitlab-alias",
          "gitlab.com",
          "ssh://port.example.com:22",
          "ssh://ssh.example.com:2200",
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("expands tilde-prefixed ssh config include patterns", () =>
    Effect.gen(function* () {
      const pattern = yield* resolveSshConfigIncludePattern(
        "~/.ssh/config.d/*.conf",
        "/tmp/project",
        "/tmp/home",
      );
      assert.equal(pattern, "/tmp/home/.ssh/config.d/*.conf");
    }).pipe(Effect.provide(NodePath.layerPosix)),
  );
});
