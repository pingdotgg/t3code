import { EnvironmentId } from "@t3tools/contracts";
import { BRAND_CLI_NAME } from "@t3tools/shared/brand";
import type { SandboxError, SandboxProvider } from "@t3tools/sandbox-providers";
import * as Effect from "effect/Effect";

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

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildBaseSetupScript(agentHarness?: string): string {
  const lines = [
    "set -eu",
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    "command -v git >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && apt-get update -y && apt-get install -y git curl ca-certificates || true)",
    "command -v python3 >/dev/null 2>&1 || (command -v apt-get >/dev/null 2>&1 && apt-get install -y python3 python3-pip || true)",
    "command -v node >/dev/null 2>&1 || (curl -fsSL https://deb.nodesource.com/setup_22.x | sh - && apt-get install -y nodejs || true)",
    `if ! command -v ${BRAND_CLI_NAME} >/dev/null 2>&1 && ! command -v t3 >/dev/null 2>&1; then npm install -g t3 || true; fi`,
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

  return lines.join(" && ");
}

function buildRepoCloneCommand(repoUrl: string, branch?: string): string {
  const branchArg = branch ? ` --branch ${shellSingleQuote(branch)}` : "";
  return [
    "set -eu",
    `mkdir -p ${WORKSPACE_ROOT}`,
    `if [ -d ${WORKSPACE_ROOT}/.git ]; then`,
    `  cd ${WORKSPACE_ROOT} && git fetch --all --prune`,
    ...(branch
      ? [`&& git checkout ${shellSingleQuote(branch)} && git pull --ff-only || true`]
      : [`&& git pull --ff-only || true`]),
    "else",
    `  rm -rf ${WORKSPACE_ROOT} && git clone --depth 1${branchArg} ${shellSingleQuote(repoUrl)} ${WORKSPACE_ROOT}`,
    "fi",
  ].join(" ");
}

export function buildHeadlessServerStartCommand(options: {
  readonly port: number;
  readonly cwd: string;
}): string {
  const cliLookup = `CLI=$(command -v ${BRAND_CLI_NAME} || command -v t3 || echo "npx -y t3")`;
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    "export T3CODE_ENVIRONMENT_MACHINE_KIND=cloud",
    cliLookup,
    `mkdir -p ${options.cwd}`,
    `cd ${options.cwd}`,
    `exec $CLI serve --lan --port ${options.port} --no-browser`,
  ].join(" && ");
}

export function buildPairingCommand(publicUrl: string | null): string {
  const cliLookup = `CLI=$(command -v ${BRAND_CLI_NAME} || command -v t3 || echo "npx -y t3")`;
  const urlFlag = publicUrl !== null ? ` --url ${shellSingleQuote(publicUrl)}` : "";
  return [
    'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:$PATH"',
    cliLookup,
    `$CLI pair${urlFlag}`,
  ].join(" && ");
}

export function extractPairingUrl(output: string): string | undefined {
  const match = output.match(/(?:https?:\/\/|kbcode:\/\/|t3code:\/\/)[^\s"'<>]+/u);
  return match?.[0];
}

function extractEnvironmentId(output: string): EnvironmentId | null {
  const trimmed = output.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return null;
  return EnvironmentId.make(trimmed);
}

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
    yield* input.driver.exec({
      providerSandboxId: input.providerSandboxId,
      command: buildBaseSetupScript(input.agentHarness),
      env: runtimeEnv,
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

  const workspaceCwd = input.repoUrl !== undefined ? WORKSPACE_ROOT : "$HOME";
  if (input.repoUrl !== undefined) {
    yield* input.driver.exec({
      providerSandboxId: input.providerSandboxId,
      command: buildRepoCloneCommand(input.repoUrl, input.branch),
      env: runtimeEnv,
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
      command: buildPairingCommand(connectionUrl),
      env: runtimeEnv,
    })
    .pipe(Effect.orElseSucceed(() => ({ exitCode: 1, stdout: "", stderr: "" })));
  const pairingUrl = pairExec.exitCode === 0 ? extractPairingUrl(pairExec.stdout) : undefined;

  const envIdExec = yield* input.driver
    .exec({
      providerSandboxId: input.providerSandboxId,
      command: 'cat "$HOME/.t3/userdata/environment-id" 2>/dev/null || true',
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
