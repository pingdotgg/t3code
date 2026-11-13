import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { discoverSshHosts, parseKnownHosts } from "./config.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-test-" });
  });
}

describe("ssh config", () => {
  it.effect("deduplicates hosts through quoted, escaped, and Unicode Includes", () =>
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
      const unicodeFiles = [
        "\u00a0team\u00a0one.conf",
        "team\u2003one.conf",
        "team\u2028one.conf",
        "team\u2029one.conf",
      ].flatMap((file) => [file, `quoted-${file}`]);
      for (const [index, file] of unicodeFiles.entries()) {
        yield* fs.writeFileString(
          path.join(sshDir, file),
          `Host unicode-${index}\n  HostName unicode-${index}.example.com\nHost *\n`,
        );
      }
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          `Include "${path.join(quotedDir, "team#1=a.conf")}" # comment`,
          `Include ${path.join(homeDir, "escaped space.conf").replaceAll(" ", "\\ ")}`,
          `Include ${unicodeFiles.map((file, index) => (index % 2 === 0 ? file : `"${file}"`)).join("\t")}`,
        ].join("\n") + "\r",
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
          ...unicodeFiles.map((_, index) => [
            `unicode-${index}`,
            `unicode-${index}.example.com`,
            "ssh-config",
          ]),
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("skips directories and implicit dotfile Include matches but keeps explicit ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(path.join(sshDir, "config.d", "ignored"), { recursive: true });
      yield* fs.makeDirectory(path.join(sshDir, "explicit-directory"));
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        "Include config.d/*\nInclude config.d/.literal.conf\nInclude config.d/.enabled-*.conf\nInclude explicit-directory\nHost real\n  HostName real.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", "team.conf"),
        "Host team\n  HostName team.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", ".backup.conf"),
        "Host *\n  HostName obsolete.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", ".literal.conf"),
        "Host literal\n  HostName literal.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config.d", ".enabled-one.conf"),
        "Host enabled\n  HostName enabled.example.com\n",
      );
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        "known.example.com ssh-ed25519 AAAA\n",
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map((host) => [host.alias, host.hostname, host.source]),
        [
          ["enabled", "enabled.example.com", "ssh-config"],
          ["known.example.com", "known.example.com", "known-hosts"],
          ["literal", "literal.example.com", "ssh-config"],
          ["real", "real.example.com", "ssh-config"],
          ["team", "team.example.com", "ssh-config"],
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
      yield* fs.makeDirectory(path.join(sshDir, "teams", "one"), { recursive: true });
      const blockedDir = path.join(sshDir, "teams", "blocked");
      yield* fs.makeDirectory(blockedDir);
      yield* fs.chmod(blockedDir, 0o000);
      yield* Effect.addFinalizer(() => fs.chmod(blockedDir, 0o755).pipe(Effect.ignore));
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          "Host devbox devbox-admin",
          "  HostName 'devbox.example.com'",
          "Host=equalsbox",
          "Host *",
          "Include=config.d/*.conf",
          "Include teams/*/*.conf",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "teams", "one", "hosts.conf"),
        "Host fixture\n  HostName fixture.example.com\n",
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
          port: 2222,
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
          alias: "fixture",
          hostname: "fixture.example.com",
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

  it.effect("keeps each explicit known_hosts port as its own destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "[100.64.0.1]:2222 ssh-ed25519 AAAA",
          "[100.64.0.1]:2223 ssh-ed25519 AAAA",
          "[fd7a:115c:a1e0::1]:2222 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts
          .map((host) => `${host.hostname} ${host.port}`)
          .toSorted((left, right) => left.localeCompare(right)),
        ["100.64.0.1 2222", "100.64.0.1 2223", "fd7a:115c:a1e0::1 2222"],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps known_hosts ports that a configured alias for the address does not use", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDir = yield* makeTempHomeDir();
      const sshDir = path.join(homeDir, ".ssh");
      yield* fs.makeDirectory(sshDir);
      yield* fs.writeFileString(
        path.join(sshDir, "known_hosts"),
        [
          "[192.0.2.10]:2222 ssh-ed25519 AAAA",
          "[192.0.2.10]:2223 ssh-ed25519 AAAA",
          "[192.0.2.20]:2222 ssh-ed25519 AAAA",
          "[box]:2200 ssh-ed25519 AAAA",
          "box ssh-ed25519 AAAA",
          "192.0.2.20 ssh-ed25519 AAAA",
          "",
        ].join("\n"),
      );
      yield* fs.writeFileString(
        path.join(sshDir, "config"),
        [
          "Host fixture",
          "  HostName 192.0.2.10",
          "  Port 22",
          "Host prod",
          "  HostName 192.0.2.20",
          "  Port 2222",
          "Host box",
          "  Port 2200",
          "",
        ].join("\n"),
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(
        hosts.map((host) => `${host.alias} ${host.port}`),
        ["192.0.2.10 2222", "192.0.2.10 2223", "box null", "fixture null", "prod null"],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("parses known_hosts entries without returning hashed hosts", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseKnownHosts(
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
          { hostname: "::1", port: null },
          { hostname: "2001:db8::1", port: null },
          { hostname: "github.com", port: null },
          { hostname: "gitlab-alias", port: null },
          { hostname: "gitlab.com", port: null },
          { hostname: "port.example.com", port: null },
          { hostname: "ssh.example.com", port: 2200 },
        ],
      );
    }),
  );
});
