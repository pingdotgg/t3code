// @effect-diagnostics nodeBuiltinImport:off - hashing image and container names.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { sandboxExecLauncherArgs } from "./SandboxTunnel.ts";

/**
 * The sandbox image: a Debian Node image with Claude Code and Codex pinned to
 * the versions T3 runs on the host, and a user whose uid, gid, and home path match the
 * host. Matching ids keep files the agent writes in the worktree owned by the
 * user. Matching the home path lets the provider config folders mount at the
 * same paths, so session files the host reads stay where it expects them.
 * The user has passwordless sudo so agents can install services like
 * databases inside their own sandbox.
 */
export const SANDBOX_DOCKERFILE = `FROM node:24
ARG SANDBOX_UID
ARG SANDBOX_GID
ARG SANDBOX_HOME
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
RUN apt-get update \\
 && apt-get install -y --no-install-recommends sudo ripgrep jq less procps lsof iproute2 \\
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@\${CLAUDE_VERSION}" "@openai/codex@\${CODEX_VERSION}" \\
 && npm cache clean --force
RUN userdel -r node 2>/dev/null || true \\
 && (getent group "\${SANDBOX_GID}" >/dev/null || groupadd -g "\${SANDBOX_GID}" t3) \\
 && useradd -o -u "\${SANDBOX_UID}" -g "\${SANDBOX_GID}" -d "\${SANDBOX_HOME}" -m -s /bin/bash t3 \\
 && echo "t3 ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/t3 \\
 && chmod 0440 /etc/sudoers.d/t3
USER \${SANDBOX_UID}:\${SANDBOX_GID}
ENV HOME=\${SANDBOX_HOME} SHELL=/bin/bash \\
    GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=*
CMD ["sleep", "infinity"]
`;

/** Labels on every container and image T3 creates. Containers carry enough to be adopted. */
export const SANDBOX_LABELS = {
  sandbox: "t3code.sandbox",
  /** Hash of the owning server's state dir, so servers on one machine never adopt each other's. */
  owner: "t3code.sandbox.owner",
  worktree: "t3code.sandbox.worktree",
  claude: "t3code.sandbox.claude",
  codex: "t3code.sandbox.codex",
} as const;

/** Claude Code and Codex versions installed in the image, or "latest". */
export interface SandboxCliVersions {
  readonly claude: string;
  readonly codex: string;
}

export interface SandboxImageInput {
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
  readonly versions: SandboxCliVersions;
}

const shortHash = (value: string, length: number) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, length);

/** Images are content addressed, so a new CLI version builds a new image. */
export const sandboxImageTag = (input: SandboxImageInput): string =>
  `t3code-sandbox:${shortHash(
    JSON.stringify([
      SANDBOX_DOCKERFILE,
      input.uid,
      input.gid,
      input.home,
      input.versions.claude,
      input.versions.codex,
    ]),
    12,
  )}`;

export const sandboxImageBuildArgs = (
  input: SandboxImageInput,
  tag: string,
): ReadonlyArray<string> => [
  "build",
  "--progress=plain",
  "--label",
  `${SANDBOX_LABELS.sandbox}=1`,
  "--build-arg",
  `SANDBOX_UID=${input.uid}`,
  "--build-arg",
  `SANDBOX_GID=${input.gid}`,
  "--build-arg",
  `SANDBOX_HOME=${input.home}`,
  "--build-arg",
  `CLAUDE_VERSION=${input.versions.claude}`,
  "--build-arg",
  `CODEX_VERSION=${input.versions.codex}`,
  "-t",
  tag,
  "-",
];

/** Owner label value for a server state dir. */
export const sandboxOwner = (stateDir: string): string => shortHash(stateDir, 16);

/** Stable per worktree, readable in `docker ps`. */
export const sandboxContainerName = (worktreePath: string): string => {
  const slug =
    NodePath.basename(worktreePath)
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/g, "-")
      .slice(0, 40)
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "") || "worktree";
  return `t3code-sandbox-${slug}-${shortHash(worktreePath, 8)}`;
};

/**
 * Host port to try first for a forwarded container port. Stable per
 * container and port, so preview URLs survive server restarts.
 */
export const preferredSandboxHostPort = (containerName: string, containerPort: number): number =>
  42000 + (Number.parseInt(shortHash(`${containerName}:${containerPort}`, 6), 16) % 8000);

export interface SandboxMount {
  readonly path: string;
  readonly readOnly: boolean;
}

/** Each mount lands at the same path inside the container. */
export const dockerRunArgs = (input: {
  readonly owner: string;
  readonly containerName: string;
  readonly image: string;
  readonly worktreePath: string;
  readonly versions: SandboxCliVersions;
  readonly mounts: ReadonlyArray<SandboxMount>;
  /** Docker disables IPv6 in containers by default; a server bound to ::1 needs it on loopback. */
  readonly ipv6Loopback: boolean;
}): ReadonlyArray<string> => [
  "run",
  "--detach",
  "--init",
  "--name",
  input.containerName,
  "--hostname",
  "t3-sandbox",
  "--label",
  `${SANDBOX_LABELS.sandbox}=1`,
  "--label",
  `${SANDBOX_LABELS.owner}=${input.owner}`,
  "--label",
  `${SANDBOX_LABELS.worktree}=${input.worktreePath}`,
  "--label",
  `${SANDBOX_LABELS.claude}=${input.versions.claude}`,
  "--label",
  `${SANDBOX_LABELS.codex}=${input.versions.codex}`,
  ...(input.ipv6Loopback ? ["--sysctl", "net.ipv6.conf.lo.disable_ipv6=0"] : []),
  ...input.mounts.flatMap((mount) => [
    "--mount",
    `type=bind,source=${mount.path},target=${mount.path}${mount.readOnly ? ",readonly" : ""}`,
  ]),
  input.image,
];

/** `--mount` is comma separated, so a comma in a path cannot be expressed. */
export const isMountablePath = (path: string): boolean => !path.includes(",");

const SKIPPED_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMPDIR",
  "TMP",
  "TEMP",
  "HOSTNAME",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "NODE_PATH",
  "APPIMAGE",
  "APPDIR",
  "OWD",
  "ARGV0",
]);
const SKIPPED_PREFIXES = [
  "XDG_",
  "DBUS_",
  "LD_",
  "DYLD_",
  "ELECTRON_",
  "VSCODE_",
  "TERM_PROGRAM",
  "__CF",
  "npm_",
  "CHROME_",
];
/** Inherited host variables worth passing: provider credentials, proxies, locale. */
const INHERITED_NAMES =
  /^(ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_|AWS_|GOOGLE_|GEMINI_|VERTEX_|AZURE_|LC_)|^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy|all_proxy|LANG|TERM|COLORTERM|TZ|GH_TOKEN|GITHUB_TOKEN)$/;

/**
 * Names of the variables a sandboxed command should receive. A command's env
 * is usually the server's own env plus overrides. Host paths and session
 * plumbing (PATH, HOME, XDG_*) would break inside the container, so only the
 * overrides and a short list of inherited credentials and locale pass through.
 */
export const sandboxEnvNames = (
  env: NodeJS.ProcessEnv,
  hostEnv: NodeJS.ProcessEnv,
): ReadonlyArray<string> =>
  Object.keys(env)
    .filter((name) => {
      const value = env[name];
      if (value === undefined || name.includes("=")) return false;
      if (SKIPPED_NAMES.has(name) || SKIPPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
        return false;
      }
      return value !== hostEnv[name] || INHERITED_NAMES.test(name);
    })
    .toSorted();

/**
 * `docker exec` arguments for one command. Values travel in the Docker
 * client's own env (`-e NAME` copies them), so secrets never appear in argv.
 */
export const dockerExecArgs = (input: {
  readonly containerName: string;
  readonly execId: string;
  readonly cwd: string;
  readonly envNames: ReadonlyArray<string>;
  readonly tty: boolean;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}): ReadonlyArray<string> => [
  "exec",
  input.tty ? "-it" : "-i",
  "-w",
  input.cwd,
  ...input.envNames.flatMap((name) => ["-e", name]),
  input.containerName,
  ...sandboxExecLauncherArgs(input.execId, input.command, input.args),
];
