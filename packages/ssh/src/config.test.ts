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
  it.effect("deduplicates hosts through quoted and escaped Include paths like OpenSSH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      const quotedDir = path.join(homeDir, "quoted dir");
      yield* fs.makeDirectory(sshDir);
      yield* fs.makeDirectory(quotedDir);
      yield* fs.writeFileString(
        path.join(quotedDir, "team#1=a.conf"),
        'Host quoted\n  HostName quoted".example.com"\nHost *\n',
      );
      yield* fs.writeFileString(
        path.join(homeDir, "escaped space.conf"),
        "Host escaped\n  HostName escaped.example.com\nHost *\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          `Include "${path.join(quotedDir, "team#1=a.conf")}" # comment`,
          `Include ${path.join(homeDir, "escaped space.conf").replaceAll(" ", "\\ ")}`,
          "",
        ].join("\n"),
      );

      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        "escaped.example.com ssh-ed25519 AAAA\nquoted.example.com ssh-ed25519 AAAA\n",
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map((host) => [host.alias, host.hostname, host.source]),
        [
          ["escaped", "escaped.example.com", "ssh-config"],
          ["quoted", "quoted.example.com", "ssh-config"],
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

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
          "Host devbox devbox-admin",
          "  HostName 'devbox.example.com'",
          "Host=equalsbox",
          "Host *",
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
          "devbox.example.com ssh-ed25519 AAAA",
          "staging.example.com ssh-ed25519 AAAA",
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
          alias: "devbox-admin",
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

  it.effect("retains raw targets when included hostnames are inactive or uncertain", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          "Host WORK*",
          "  HostName case-sensitive.example.com",
          "Host work",
          "Host dev",
          "  Include conditional.conf",
          "Host prod",
          "Host matched",
          "Match originalhost matched",
          "  Include match.conf",
          "Host matched",
          "  HostName fallback.example.com",
          "Host bracketed",
          "  Include bracket-[ab].conf",
          "  HostName bracket-fallback.example.com",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "conditional.conf"),
        "Host prod\n  HostName blocked.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "match.conf"),
        "Host matched\n  HostName match.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "bracket-a.conf"),
        "HostName bracket-real.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "bracket-real.example.com ssh-ed25519 AAAA",
          "bracket-fallback.example.com ssh-ed25519 AAAA",
          "blocked.example.com ssh-ed25519 AAAA",
          "case-sensitive.example.com ssh-ed25519 AAAA",
          "match.example.com ssh-ed25519 AAAA",
          "fallback.example.com ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.filter((host) => host.source === "known-hosts").map((host) => host.hostname),
        [
          "blocked.example.com",
          "bracket-fallback.example.com",
          "bracket-real.example.com",
          "case-sensitive.example.com",
          "fallback.example.com",
          "match.example.com",
        ],
      );
      assert.equal(hosts.find((host) => host.alias === "bracketed")?.hostname, "bracketed");
      assert.equal(hosts.find((host) => host.alias === "prod")?.hostname, "prod");
      assert.equal(hosts.find((host) => host.alias === "work")?.hostname, "work");
      assert.equal(hosts.find((host) => host.alias === "matched")?.hostname, "matched");
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
