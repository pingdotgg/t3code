// @effect-diagnostics nodeBuiltinImport:off - validates repository-owned Docker files directly.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readRepositoryFile = (path: string) => readFileSync(join(repositoryRoot, path), "utf8");

const expectedCredentialIgnores = [
  "**/.t3",
  "**/.env",
  "**/.env.*",
  "**/.codex/auth.json",
  "**/.claude.json",
  "**/.claude/.credentials.json",
  "**/.cursor/cli-config.json",
  "**/.config/opencode",
  "**/.local/share/opencode",
  "**/.ssh",
] as const;

describe("Docker distribution", () => {
  it("keeps credential-bearing paths out of the build context", () => {
    const ignored = new Set(
      readRepositoryFile(".dockerignore")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#")),
    );

    for (const pattern of expectedCredentialIgnores) {
      expect(ignored.has(pattern), `missing .dockerignore rule: ${pattern}`).toBe(true);
    }
  });

  it("keeps machine-local provider logins out of git", () => {
    const gitignore = readRepositoryFile(".gitignore");
    for (const pattern of [
      "/.codex/auth.json",
      "/.claude.json",
      "/.claude/.credentials.json",
      "/.cursor/cli-config.json",
      "/.config/opencode/",
      "/.local/share/opencode/",
      "/.ssh/",
    ]) {
      expect(gitignore).toContain(pattern);
    }
  });

  it("builds a non-root runtime without secret-valued build arguments", () => {
    const dockerfile = readRepositoryFile("Dockerfile");

    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain('ENTRYPOINT ["t3"]');
    expect(dockerfile).toContain('CMD ["serve", "/workspace"]');
    expect(dockerfile).not.toMatch(
      /^\s*(?:ARG|ENV)\s+[^\n]*(?:ACCESS_TOKEN|AUTH_TOKEN|API_KEY|PASSWORD|PRIVATE_KEY|SECRET_KEY)/imu,
    );
  });

  it("mounts state and source separately without exposing the Docker socket", () => {
    const compose = parse(readRepositoryFile("compose.yaml")) as {
      readonly services: {
        readonly t3: {
          readonly hostname: string;
          readonly environment: Readonly<Record<string, string | number>>;
          readonly volumes: ReadonlyArray<{
            readonly type: string;
            readonly source: string;
            readonly target: string;
          }>;
        };
      };
    };
    const service = compose.services.t3;

    expect(service.hostname).toBe("${T3_HOSTNAME:-t3-code}");
    expect(service.environment).toEqual({
      T3CODE_HOME: "/home/node/.t3",
      T3CODE_HOST: "0.0.0.0",
      T3CODE_NO_BROWSER: "true",
      T3CODE_PORT: 3773,
    });
    expect(service.volumes).toEqual([
      { type: "volume", source: "t3-home", target: "/home/node" },
      { type: "bind", source: "${T3_WORKSPACE_PATH:-.}", target: "/workspace" },
    ]);
    expect(JSON.stringify(service)).not.toContain("/var/run/docker.sock");
  });
});
