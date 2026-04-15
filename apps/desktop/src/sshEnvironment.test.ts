import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { __test, discoverDesktopSshHosts } from "./sshEnvironment";

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
  it("discovers ssh config hosts across included files", async () => {
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

  it("parses known_hosts entries without returning hashed hosts", () => {
    expect(
      __test.parseKnownHostsHostnames(
        [
          "github.com ssh-ed25519 AAAA",
          "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
          "|1|hashed|entry ssh-ed25519 CCCC",
          "@cert-authority *.example.com ssh-ed25519 DDDD",
          "[ssh.example.com]:2200 ssh-ed25519 EEEE",
          "::1 ssh-ed25519 FFFF",
          "2001:db8::1 ssh-ed25519 GGGG",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      "::1",
      "2001:db8::1",
      "github.com",
      "gitlab-alias",
      "gitlab.com",
      "ssh.example.com",
    ]);
  });

  it("parses resolved ssh config output into a target", () => {
    expect(
      __test.parseSshResolveOutput(
        "devbox",
        ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
      ),
    ).toEqual({
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    });
  });

  it("builds interactive ssh args without forcing batch mode", () => {
    expect(
      __test.baseSshArgs(
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
        { batchMode: "no" },
      ),
    ).toEqual(["-o", "BatchMode=no", "-o", "ConnectTimeout=10", "-p", "2222"]);
  });

  it("creates askpass env for desktop ssh prompts", () => {
    const askpassDirectory = Path.join(makeTempHomeDir(), "askpass");
    const env = __test.buildSshChildEnvironment({
      authSecret: "super-secret",
      interactiveAuth: true,
      askpassDirectory,
      platform: "linux",
      baseEnv: {},
    });

    expect(env.SSH_ASKPASS).toBe(Path.join(askpassDirectory, "ssh-askpass.sh"));
    expect(env.SSH_ASKPASS_REQUIRE).toBe("force");
    expect(env.T3_SSH_AUTH_SECRET).toBe("super-secret");
    expect(env.DISPLAY).toBe("t3code");
    expect(FS.existsSync(Path.join(askpassDirectory, "ssh-askpass.sh"))).toBe(true);
    expect(FS.readFileSync(Path.join(askpassDirectory, "ssh-askpass.sh"), "utf8")).toContain(
      'printf "%s\\n" "$T3_SSH_AUTH_SECRET"',
    );
  });

  it("builds a windows askpass launcher pair", () => {
    const descriptor = __test.buildSshAskpassHelperDescriptor({
      directory: "C:\\temp\\t3code-ssh-askpass",
      platform: "win32",
    });

    expect(descriptor.launcherPath).toBe("C:\\temp\\t3code-ssh-askpass\\ssh-askpass.cmd");
    expect(descriptor.files.map((file) => Path.win32.basename(file.path))).toEqual([
      "ssh-askpass.cmd",
      "ssh-askpass.ps1",
    ]);
  });

  it("builds a remote t3 runner with npx and npm fallbacks", () => {
    const script = __test.buildRemoteT3RunnerScript();

    expect(script).toContain('exec t3 "$@"');
    expect(script).toContain('exec npx --yes t3@latest "$@"');
    expect(script).toContain('exec npm exec --yes t3@latest -- "$@"');
    expect(script).toContain("could not install t3@latest");
  });

  it("resolves the remote t3 package spec from the desktop release channel", () => {
    expect(
      __test.resolveRemoteT3CliPackageSpec({
        appVersion: "0.0.17",
        updateChannel: "latest",
      }),
    ).toBe("t3@0.0.17");
    expect(
      __test.resolveRemoteT3CliPackageSpec({
        appVersion: "0.0.17-nightly.20260415.44",
        updateChannel: "nightly",
      }),
    ).toBe("t3@nightly");
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    expect(__test.buildRemoteLaunchScript()).toContain(
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    expect(__test.buildRemoteLaunchScript()).toContain('"$RUNNER_FILE" serve --host 127.0.0.1');
    expect(__test.buildRemoteLaunchScript({ packageSpec: "t3@nightly" })).toContain(
      'exec npx --yes t3@nightly "$@"',
    );
    expect(__test.buildRemotePairingScript(target)).toContain(
      '"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json',
    );
    expect(__test.buildRemotePairingScript(target, { packageSpec: "t3@nightly" })).toContain(
      'exec npm exec --yes t3@nightly -- "$@"',
    );
  });

  it("reads the last non-empty ssh output line", () => {
    expect(
      __test.getLastNonEmptyOutputLine(
        ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
      ),
    ).toBe('{"credential":"pairing-token"}');
  });

  it("detects ssh auth failures from common permission denied messages", () => {
    expect(
      __test.isSshAuthFailure(
        new Error(
          "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
        ),
      ),
    ).toBe(true);
    expect(__test.isSshAuthFailure(new Error("Connection timed out"))).toBe(false);
  });
});
