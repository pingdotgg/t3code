import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { canonicalizeSshRemoteUrl, SshHostnameCache } from "./sshRemoteUrl.ts";

const sshConfig = (hostname: string) => (host: string) =>
  Effect.succeed(`host ${host}\r\nhostname ${hostname}\r\nport 22\r\nuser git\r\n`);

const unresolved = (host: string) => Effect.succeed(`hostname ${host}\n`);

describe("canonicalizeSshRemoteUrl", () => {
  it.effect("resolves an scp-style alias to its configured hostname", () =>
    Effect.gen(function* () {
      expect(
        yield* canonicalizeSshRemoteUrl("git@alt:pingdotgg/t3chat.git", sshConfig("github.com")),
      ).toBe("git@github.com:pingdotgg/t3chat.git");
    }),
  );

  it.effect("resolves an alias in an ssh:// remote, port and path intact", () =>
    Effect.gen(function* () {
      expect(
        yield* canonicalizeSshRemoteUrl(
          "ssh://git@work-main:2222/pingdotgg/t3chat.git",
          sshConfig("gitlab.example.com"),
        ),
      ).toBe("ssh://git@gitlab.example.com:2222/pingdotgg/t3chat.git");
    }),
  );

  it.effect("probes each host once", () =>
    Effect.gen(function* () {
      let probes = 0;
      const probe = (host: string) => {
        probes += 1;
        return sshConfig("github.com")(host);
      };
      yield* canonicalizeSshRemoteUrl("git@cached-alias:pingdotgg/t3chat.git", probe);
      yield* canonicalizeSshRemoteUrl("git@cached-alias:pingdotgg/t3code.git", probe);
      expect(probes).toBe(1);
    }).pipe(Effect.provideService(SshHostnameCache, new Map())),
  );

  it.effect("retries after a failed probe instead of caching it", () =>
    Effect.gen(function* () {
      const results = ["", "hostname github.com\n"];
      const probe = () => Effect.succeed(results.shift() ?? "");
      yield* canonicalizeSshRemoteUrl("git@flaky:pingdotgg/t3chat.git", probe);
      expect(yield* canonicalizeSshRemoteUrl("git@flaky:pingdotgg/t3chat.git", probe)).toBe(
        "git@github.com:pingdotgg/t3chat.git",
      );
    }).pipe(Effect.provideService(SshHostnameCache, new Map())),
  );

  it.effect("brackets an IPv6 hostname before substitution", () =>
    Effect.gen(function* () {
      expect(
        yield* canonicalizeSshRemoteUrl("git@v6:pingdotgg/t3chat.git", sshConfig("2001:db8::1")),
      ).toBe("git@[2001:db8::1]:pingdotgg/t3chat.git");
      expect(
        yield* canonicalizeSshRemoteUrl(
          "ssh://git@v6:2222/pingdotgg/t3chat.git",
          sshConfig("2001:db8::1"),
        ),
      ).toBe("ssh://git@[2001:db8::1]:2222/pingdotgg/t3chat.git");
    }).pipe(Effect.provideService(SshHostnameCache, new Map())),
  );

  it.effect("leaves non-ssh remotes and local paths alone", () =>
    Effect.gen(function* () {
      const failing = () => Effect.die("ssh must not be probed");
      for (const remoteUrl of [
        "https://github.com/pingdotgg/t3chat.git",
        "git://github.com/pingdotgg/t3chat.git",
        "/home/me/repo",
        "C:/Users/me/repo",
        "C:\\Users\\me\\repo",
        "../sibling/repo",
      ]) {
        expect(yield* canonicalizeSshRemoteUrl(remoteUrl, failing)).toBe(remoteUrl);
      }
    }),
  );

  it.effect("leaves a host that ssh does not rewrite alone", () =>
    Effect.gen(function* () {
      expect(
        yield* canonicalizeSshRemoteUrl("git@github.com:pingdotgg/t3chat.git", unresolved),
      ).toBe("git@github.com:pingdotgg/t3chat.git");
    }),
  );

  it.effect("keeps the remote when ssh cannot be run", () =>
    Effect.gen(function* () {
      expect(
        yield* canonicalizeSshRemoteUrl("git@no-ssh-here:pingdotgg/t3chat.git", () =>
          Effect.succeed(""),
        ),
      ).toBe("git@no-ssh-here:pingdotgg/t3chat.git");
    }),
  );
});
