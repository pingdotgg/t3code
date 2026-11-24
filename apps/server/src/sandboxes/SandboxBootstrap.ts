import * as NodeOS from "node:os";

import { EnvironmentId } from "@t3tools/contracts";
import { BRAND_CLI_NAME } from "@t3tools/shared/brand";
import { SandboxError, type SandboxProvider } from "@t3tools/sandbox-providers";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { SANDBOX_SERVER_PORT } from "./SandboxConfig.ts";

export interface SandboxBootstrapInput {
  readonly driver: SandboxProvider["Service"];
  readonly providerSandboxId: string;
  readonly name: string;
  readonly port?: number | undefined;
  readonly bootedFromSnapshot: boolean;
  readonly createBaseSnapshot?: boolean | undefined;
  readonly repoUrl?: string | undefined;
  readonly branch?: string | undefined;
  readonly agentHarness?: string | undefined;
  readonly cliPackageSpec?: string | undefined;
  readonly forwardHostOAuth?: boolean | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly connectionUrlHint?: string | undefined;
}

export interface SandboxBootstrapResult {
  readonly connectionUrl: string | null;
  readonly pairingUrl: string | undefined;
  readonly environmentId: EnvironmentId | null;
  readonly baseSnapshotId: string | null;
}

const WORKSPACE_ROOT = "$HOME/workspace";

interface OAuthCredentialMapping {
  readonly envKey: string;
  readonly hostSegments: ReadonlyArray<string>;
  readonly sandboxRelPath: string;
}

const HOST_OAUTH_CREDENTIAL_MAPPINGS: ReadonlyArray<OAuthCredentialMapping> = [
  {
    envKey: "KBCODE_SYNC_OAUTH_CLAUDE_B64",
    hostSegments: [".claude", ".credentials.json"],
    sandboxRelPath: ".claude/.credentials.json",
  },
  {
    envKey: "KBCODE_SYNC_OAUTH_CODEX_B64",
    hostSegments: [".codex", "auth.json"],
    sandboxRelPath: ".codex/auth.json",
  },
  {
    envKey: "KBCODE_SYNC_OAUTH_OPENCODE_B64",
    hostSegments: [".local", "share", "opencode", "auth.json"],
    sandboxRelPath: ".local/share/opencode/auth.json",
  },
  {
    envKey: "KBCODE_SYNC_OAUTH_PRIME_B64",
    hostSegments: [".prime", "config.json"],
    sandboxRelPath: ".prime/config.json",
  },
];

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildBaseSetupScript(agentHarness?: string, cliPackageSpec?: string): string {
  const pkgSpec = cliPackageSpec?.trim() || "t3";
  const lines = [
    "set -eu",
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    "command -v git >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && apt-get update -y && apt-get install -y git curl ca-certificates || true)",
    "command -v python3 >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && apt-get install -y python3 python3-pip || true)",
    "command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_22.x | sh - && apt-get install -y nodejs || true)",
    `if ! command -v ${BRAND_CLI_NAME} >/dev/null 2>&1 && ! command -v t3 >/dev/null 2>&1; then npm install -g ${shellSingleQuote(pkgSpec)} || npm install -g --prefix "$HOME/.npm-global" ${shellSingleQuote(pkgSpec)} || true; fi`,
    `if command -v t3 >/dev/null 2>&1 && ! command -v ${BRAND_CLI_NAME} >/dev/null 2>&1; then mkdir -p "$HOME/.local/bin" && ln -sf "$(command -v t3)" "$HOME/.local/bin/${BRAND_CLI_NAME}"; fi`,
    "if ! command -v prime-agent >/dev/null 2>&1; then curl -fsSL https://app.primeintellect.ai/prime-agent/install.sh | sh || true; fi",
  ];

  const normalizedHarness = agentHarness?.trim().toLowerCase();
  if (normalizedHarness === "claude" || normalizedHarness === "claude-code") {
    lines.push(
      "command -v claude >/dev/null 2>&1 || npm install -g @anthropic-ai/claude-code || true",
    );
  } else if (normalizedHarness === "codex") {
    lines.push("command -v codex >/dev/null 2>&1 || npm install -g @openai/codex || true");
  } else if (normalizedHarness === "opencode") {
    lines.push("command -v opencode >/dev/null 2>&1 || npm install -g opencode-ai || true");
  }

  return lines.join("\n");
}

export function buildRepoCloneCommand(repoUrl: string, branch?: string): string {
  const branchArg = branch ? ` --branch ${shellSingleQuote(branch)}` : "";
  const isHttpsGithub = /^https:\/\/([^/]*@)?github\.com\//iu.test(repoUrl.trim());
  const gitAuthPrefix = isHttpsGithub
    ? 'if [ -n "${GITHUB_TOKEN:-}" ]; then GIT_AUTH="-c credential.helper=!f(){ echo username=x-access-token; echo password=$GITHUB_TOKEN; };f"; else GIT_AUTH=""; fi'
    : 'GIT_AUTH=""';
  return [
    "set -eu",
    gitAuthPrefix,
    `mkdir -p ${WORKSPACE_ROOT}`,
    `if [ -d ${WORKSPACE_ROOT}/.git ]; then`,
    `  cd ${WORKSPACE_ROOT}`,
    `  git $GIT_AUTH fetch --all --prune`,
    ...(branch
      ? [`  git checkout ${shellSingleQuote(branch)}`, `  git $GIT_AUTH pull --ff-only || true`]
      : [`  git $GIT_AUTH pull --ff-only || true`]),
    "else",
    `  rm -rf ${WORKSPACE_ROOT}`,
    `  git $GIT_AUTH clone --depth 1${branchArg} ${shellSingleQuote(repoUrl)} ${WORKSPACE_ROOT}`,
    "fi",
  ].join("\n");
}

export const collectHostOAuthSyncPayload = Effect.fn("SandboxBootstrap.collectHostOAuth")(
  function* (homeDir: string = NodeOS.homedir()) {
    const fsOpt = yield* Effect.serviceOption(FileSystem.FileSystem);
    const pathOpt = yield* Effect.serviceOption(Path.Path);
    if (Option.isNone(fsOpt) || Option.isNone(pathOpt)) {
      return { env: {} as Record<string, string>, command: null as string | null };
    }
    const fs = fsOpt.value;
    const path = pathOpt.value;
    const env: Record<string, string> = {};
    const writeLines: string[] = ["set -eu", "umask 077"];

    for (const mapping of HOST_OAUTH_CREDENTIAL_MAPPINGS) {
      const hostPath = path.join(homeDir, ...mapping.hostSegments);
      const contentOpt = yield* fs.readFile(hostPath).pipe(Effect.option);
      if (Option.isNone(contentOpt) || contentOpt.value.length === 0) continue;
      env[mapping.envKey] = Buffer.from(contentOpt.value).toString("base64");
      const targetPath = `"$HOME/${mapping.sandboxRelPath}"`;
      writeLines.push(
        `mkdir -p "$(dirname ${targetPath})"`,
        `printf '%s' "$${mapping.envKey}" | base64 -d > ${targetPath}`,
        `chmod 600 ${targetPath}`,
      );
    }

    return {
      env,
      command: Object.keys(env).length > 0 ? writeLines.join("\n") : null,
    };
  },
);

export function buildHeadlessServerStartCommand(options: {
  readonly port: number;
  readonly cwd: string;
}): string {
  const cliLookup = `CLI=$(command -v ${BRAND_CLI_NAME} || command -v t3 || echo "npx -y t3")`;
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    "export T3CODE_ENVIRONMENT_MACHINE_KIND=cloud",
    `if curl -fsS "http://127.0.0.1:${options.port}/.well-known/t3/environment" >/dev/null 2>&1; then exit 0; fi`,
    'if [ -n "${TAILSCALE_AUTHKEY:-}" ] && command -v tailscale >/dev/null 2>&1; then tailscale up --authkey="$TAILSCALE_AUTHKEY" >/dev/null 2>&1 || true; fi',
    cliLookup,
    `mkdir -p ${options.cwd}`,
    `cd ${options.cwd}`,
    // Bind 0.0.0.0 without --lan so cloud reverse-proxy / IPv6 ingress is not rejected as non-RFC1918.
    `exec $CLI serve --host 0.0.0.0 --port ${options.port} --no-browser`,
  ].join("\n");
}

export function buildPairingCommand(port: number = SANDBOX_SERVER_PORT): string {
  const cliLookup = `CLI=$(command -v ${BRAND_CLI_NAME} || command -v t3 || echo "npx -y t3")`;
  // Wait briefly for the detached server to publish its runtime state before minting a pairing link.
  const waitForReady = `i=0; while [ "$i" -lt 30 ]; do curl -fsS "http://127.0.0.1:${port}/.well-known/t3/environment" >/dev/null 2>&1 && break; i=$((i + 1)); sleep 1; done`;
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    cliLookup,
    waitForReady,
    "$CLI pair",
  ].join(" && ");
}

export function buildEnvironmentIdCommand(port: number = SANDBOX_SERVER_PORT): string {
  return [
    `BODY=$(curl -fsS "http://127.0.0.1:${port}/.well-known/t3/environment" 2>/dev/null || true)`,
    `if [ -n "$BODY" ] && command -v node >/dev/null 2>&1; then node -e 'try { const d = JSON.parse(process.argv[1]); if (typeof d.environmentId === "string") process.stdout.write(d.environmentId); } catch {}' "$BODY"; fi`,
    `if [ -z "$BODY" ]; then cat "$HOME/.t3/userdata/environment-id" 2>/dev/null || true; fi`,
  ].join("\n");
}

function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1") {
    return true;
  }
  if (/^10\./u.test(host) || /^192\.168\./u.test(host)) return true;
  const match172 = /^172\.(\d+)\./u.exec(host);
  if (match172 !== null) {
    const secondOctet = Number(match172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return false;
}

export function rewritePairingUrlForPublicOrigin(
  pairingUrl: string | undefined,
  publicUrl: string | null,
): string | undefined {
  if (pairingUrl === undefined || publicUrl === null) return pairingUrl;
  try {
    const parsedPairing = new URL(pairingUrl);
    const parsedPublic = new URL(publicUrl);
    if (
      (parsedPairing.protocol === "http:" || parsedPairing.protocol === "https:") &&
      isLocalOrPrivateHost(parsedPairing.hostname)
    ) {
      return new URL(
        `${parsedPairing.pathname}${parsedPairing.search}${parsedPairing.hash}`,
        parsedPublic.origin,
      ).toString();
    }
  } catch {
    // Keep original string if either URL cannot be parsed.
  }
  return pairingUrl;
}

function stripTrailingUrlPunctuation(raw: string): string {
  return raw.replace(/[).,;]+$/u, "");
}

export function extractPairingUrl(output: string): string | undefined {
  const labeledMatch = output.match(
    /^\s*Pairing URL:\s*((?:https?:\/\/|kbcode:\/\/|t3code:\/\/)[^\s"'<>]+)/mu,
  );
  if (labeledMatch?.[1]) {
    return stripTrailingUrlPunctuation(labeledMatch[1]);
  }
  const tokenizedMatch = output.match(
    /(?:https?:\/\/|kbcode:\/\/|t3code:\/\/)[^\s"'<>]*#token=[^\s"'<>]+/u,
  );
  if (tokenizedMatch?.[0]) {
    return stripTrailingUrlPunctuation(tokenizedMatch[0]);
  }
  const fallbackMatch = output.match(/(?:https?:\/\/|kbcode:\/\/|t3code:\/\/)[^\s"'<>]+/u);
  return fallbackMatch?.[0] ? stripTrailingUrlPunctuation(fallbackMatch[0]) : undefined;
}

export function extractEnvironmentId(output: string): EnvironmentId | null {
  const trimmed = output.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  return EnvironmentId.make(trimmed);
}

const requireExecSuccess = Effect.fn("SandboxBootstrap.requireExecSuccess")(function* (input: {
  readonly driver: SandboxProvider["Service"];
  readonly providerSandboxId: string;
  readonly step: string;
  readonly result: { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
}) {
  if (input.result.exitCode === 0) return;
  const detail = (input.result.stderr || input.result.stdout).trim().slice(0, 400);
  return yield* new SandboxError({
    provider: input.driver.kind,
    operation: "exec",
    category: "command_failed",
    sandboxId: input.providerSandboxId,
    exitCode: input.result.exitCode,
    cause: new Error(
      detail.length > 0
        ? `Bootstrap step "${input.step}" failed (exit ${input.result.exitCode}): ${detail}`
        : `Bootstrap step "${input.step}" failed with exit code ${input.result.exitCode}.`,
    ),
  });
});

export const bootstrapSandbox = Effect.fn("SandboxBootstrap.run")(function* (
  input: SandboxBootstrapInput,
): Effect.fn.Return<SandboxBootstrapResult, SandboxError> {
  const port = input.port ?? SANDBOX_SERVER_PORT;
  const runtimeEnv: Record<string, string> = {
    ...input.env,
    T3CODE_ENVIRONMENT_MACHINE_KIND: "cloud",
  };

  let baseSnapshotId: string | null = null;
  if (!input.bootedFromSnapshot) {
    const setupRes = yield* input.driver.exec({
      providerSandboxId: input.providerSandboxId,
      command: buildBaseSetupScript(input.agentHarness, input.cliPackageSpec),
      env: runtimeEnv,
    });
    yield* requireExecSuccess({
      driver: input.driver,
      providerSandboxId: input.providerSandboxId,
      step: "base-setup",
      result: setupRes,
    });

    if (input.createBaseSnapshot) {
      const snap = yield* input.driver.snapshot({
        providerSandboxId: input.providerSandboxId,
        name: `${input.name}-base`,
      });
      baseSnapshotId = snap.snapshotId;
      if (snap.stoppedAfterSnapshot) {
        yield* input.driver.resume(input.providerSandboxId, { port });
      }
    }
  }

  if (input.forwardHostOAuth) {
    const oauthSync = yield* collectHostOAuthSyncPayload();
    if (oauthSync.command !== null) {
      const oauthRes = yield* input.driver.exec({
        providerSandboxId: input.providerSandboxId,
        command: oauthSync.command,
        env: oauthSync.env,
      });
      yield* requireExecSuccess({
        driver: input.driver,
        providerSandboxId: input.providerSandboxId,
        step: "oauth-sync",
        result: oauthRes,
      });
    }
  }

  const workspaceCwd = input.repoUrl !== undefined ? WORKSPACE_ROOT : "$HOME";
  if (input.repoUrl !== undefined) {
    const cloneRes = yield* input.driver.exec({
      providerSandboxId: input.providerSandboxId,
      command: buildRepoCloneCommand(input.repoUrl, input.branch),
      env: runtimeEnv,
    });
    yield* requireExecSuccess({
      driver: input.driver,
      providerSandboxId: input.providerSandboxId,
      step: "repo-clone",
      result: cloneRes,
    });
  }

  yield* input.driver.exec({
    providerSandboxId: input.providerSandboxId,
    command: buildHeadlessServerStartCommand({ port, cwd: workspaceCwd }),
    env: runtimeEnv,
    detached: true,
  });

  const resolvedUrl = yield* input.driver
    .getPublicUrl(input.providerSandboxId, port)
    .pipe(Effect.orElseSucceed(() => input.connectionUrlHint ?? null));
  const connectionUrl = resolvedUrl ?? input.connectionUrlHint ?? null;

  const pairExec = yield* input.driver
    .exec({
      providerSandboxId: input.providerSandboxId,
      command: buildPairingCommand(port),
      env: runtimeEnv,
    })
    .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
  const pairingUrl =
    pairExec.exitCode === 0
      ? rewritePairingUrlForPublicOrigin(extractPairingUrl(pairExec.stdout), connectionUrl)
      : undefined;

  const envIdExec = yield* input.driver
    .exec({
      providerSandboxId: input.providerSandboxId,
      command: buildEnvironmentIdCommand(port),
    })
    .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
  const environmentId = extractEnvironmentId(envIdExec.stdout);

  return {
    connectionUrl,
    pairingUrl,
    environmentId,
    baseSnapshotId,
  };
});
