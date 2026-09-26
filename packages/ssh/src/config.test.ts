import * as NodePath from "@effect/platform-node/NodePath";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSshHosts,
  parseKnownHostsHostnames,
  resolveSshConfigIncludePattern,
} from "./config.ts";

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
          "Include=config.d/*.conf",
          "Host devbox",
          "  HostName devbox.example.com",
          "Host=equalsbox",
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
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "devbox",
          hostname: "devbox.example.com",
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
          alias: "staging",
          hostname: "staging.example.com",
          username: null,
          port: null,
          source: "ssh-config",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("prefers configured aliases over their known_hosts targets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          "Host mini",
          "  HostName 100.111.210.10",
          "Host work-box",
          '  HostName "work.example.com"',
          "Host *",
          "  HostName fallback.example.com",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "100.111.210.10 ssh-ed25519 AAAA",
          "work.example.com ssh-ed25519 BBBB",
          "fallback.example.com ssh-ed25519 CCCC",
          "other.example.com ssh-ed25519 DDDD",
          "",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map(({ alias }) => alias),
        ["fallback.example.com", "mini", "other.example.com", "work-box"],
      );
      assert.equal(hosts.find(({ alias }) => alias === "mini")?.hostname, "100.111.210.10");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("uses the effective HostName across includes, wildcards, and Match all", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const fixture of [
        {
          config: "Host work\n  Include target.conf\n",
          included: "  HostName work.example.com\n",
          target: "work.example.com",
        },
        {
          config:
            "Host *\n  HostName bastion.example.com\nHost work\n  HostName ignored.example.com\n",
          included: "",
          target: "bastion.example.com",
        },
        {
          config: "Host work\nMatch all\n  HostName shared.example.com\n",
          included: "",
          target: "shared.example.com",
        },
        {
          config: "Match originalhost work\n  Include target.conf\n",
          included: "Host work\n  HostName work.example.com\n",
          target: "work.example.com",
        },
      ]) {
        const homeDir = yield* makeTempHomeDir();
        const sshDir = path.join(homeDir, ".ssh");
        yield* fs.makeDirectory(sshDir);
        yield* fs.writeFileString(path.join(sshDir, "config"), fixture.config);
        yield* fs.writeFileString(path.join(sshDir, "target.conf"), fixture.included);
        yield* fs.writeFileString(
          path.join(sshDir, "known_hosts"),
          `${fixture.target} ssh-ed25519 AAAA\n`,
        );

        const hosts = yield* discoverSshHosts({ homeDir });
        assert.deepEqual(hosts, [
          {
            alias: "work",
            hostname: fixture.target,
            username: null,
            port: null,
            source: "ssh-config",
          },
        ]);
      }
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect(
    "restores the enclosing Host after an Include and respects tokenized first values",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const homeDir = yield* makeTempHomeDir();
        const sshDir = path.join(homeDir, ".ssh");
        yield* fs.makeDirectory(sshDir);
        yield* fs.writeFileString(
          path.join(sshDir, "config"),
          [
            "Host work",
            "  Include nested.conf",
            "  HostName work.example.com",
            "Host tokenized",
            "  HostName %h.internal",
            "Host tokenized",
            "  HostName wrong.example.com",
            "",
          ].join("\n"),
        );
        yield* fs.writeFileString(
          path.join(sshDir, "nested.conf"),
          "Host nested\n  HostName nested.example.com\n",
        );
        yield* fs.writeFileString(
          path.join(sshDir, "known_hosts"),
          "work.example.com ssh-ed25519 AAAA\ntokenized.internal ssh-ed25519 BBBB\nwrong.example.com ssh-ed25519 CCCC\n",
        );

        const hosts = yield* discoverSshHosts({ homeDir });
        assert.deepEqual(
          hosts.map(({ alias, hostname }) => [alias, hostname]),
          [
            ["tokenized", "tokenized.internal"],
            ["work", "work.example.com"],
            ["wrong.example.com", "wrong.example.com"],
          ],
        );
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("expands supported HostName tokens without treating escaped percents as tokens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        "Host Mixed\n  HostName %h.internal\nHost escaped\n  HostName zone%%en0\nHost unsupported\n  HostName %p.internal\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        "mixed.internal ssh-ed25519 AAAA\nzone%en0 ssh-ed25519 BBBB\n",
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(Object.fromEntries(hosts.map(({ alias, hostname }) => [alias, hostname])), {
        Mixed: "mixed.internal",
        escaped: "zone%en0",
        unsupported: "unsupported",
      });
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("parses known_hosts entries without returning hashed hosts", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseKnownHostsHostnames(
          [
            "github.com ssh-ed25519 AAAA",
            "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
            "|1|hashed|entry ssh-ed25519 CCCC",
            "@cert-authority *.example.com ssh-ed25519 DDDD",
            "[ssh.example.com]:2200 ssh-ed25519 EEEE",
            "port.example.com:22 ssh-ed25519 HHHH",
            "::1 ssh-ed25519 FFFF",
            "2001:db8::1 ssh-ed25519 GGGG",
            "",
          ].join("\n"),
        ),
        [
          "::1",
          "2001:db8::1",
          "github.com",
          "gitlab-alias",
          "gitlab.com",
          "port.example.com",
          "ssh.example.com",
        ],
      );
    }),
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
