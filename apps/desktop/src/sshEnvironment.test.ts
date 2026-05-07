import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SshPasswordPromptError } from "@t3tools/ssh/errors";

import { discoverDesktopSshHosts, isSshPasswordPromptCancellation } from "./sshEnvironment.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempHomeDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-ssh-env-test-"));
  tempDirectories.push(directory);
  return directory;
}

describe("sshEnvironment", () => {
  it("treats password prompt timeouts as cancellable authentication prompts", () => {
    expect(
      isSshPasswordPromptCancellation(
        new SshPasswordPromptError({
          message: "SSH authentication timed out for devbox.",
        }),
      ),
    ).toBe(true);
  });

  it("wires desktop host discovery through the ssh package runtime", async () => {
    const homeDir = makeTempHomeDir();
    const sshDir = Path.join(homeDir, ".ssh");
    FS.mkdirSync(Path.join(sshDir, "config.d"), { recursive: true });
    FS.writeFileSync(
      Path.join(sshDir, "config"),
      ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join("\n"),
      "utf8",
    );
    FS.writeFileSync(
      Path.join(sshDir, "config.d", "team.conf"),
      [
        "Host staging",
        "  HostName staging.example.com",
        "Host *",
        "  ServerAliveInterval 30",
        "",
      ].join("\n"),
      "utf8",
    );
    FS.writeFileSync(
      Path.join(sshDir, "known_hosts"),
      [
        "known.example.com ssh-ed25519 AAAA",
        "|1|hashed|entry ssh-ed25519 AAAA",
        "[bastion.example.com]:2222 ssh-ed25519 AAAA",
        "",
      ].join("\n"),
      "utf8",
    );

    await expect(discoverDesktopSshHosts({ homeDir })).resolves.toEqual([
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
  });
});
