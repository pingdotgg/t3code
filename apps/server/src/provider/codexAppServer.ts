import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import type { ServerProviderSkill } from "@t3tools/contracts";
import { readCodexAccountSnapshot, type CodexAccountSnapshot } from "./codexAccount";

interface JsonRpcProbeResponse {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: {
    readonly message?: unknown;
  };
}

export interface CodexDiscoverySnapshot {
  readonly account: CodexAccountSnapshot;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

function readErrorMessage(response: JsonRpcProbeResponse): string | undefined {
  return typeof response.error?.message === "string" ? response.error.message : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function readArray(value: unknown): ReadonlyArray<unknown> | undefined {
  return Array.isArray(value) ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmptyTrimmed(value: unknown): string | undefined {
  const candidate = readString(value)?.trim();
  return candidate ? candidate : undefined;
}

function parseCodexSkillsResult(result: unknown, cwd: string): ReadonlyArray<ServerProviderSkill> {
  const resultRecord = readObject(result);
  const dataBuckets = readArray(resultRecord?.data) ?? [];
  const matchingBucket = dataBuckets.find(
    (value) => nonEmptyTrimmed(readObject(value)?.cwd) === cwd,
  );
  const rawSkills =
    readArray(readObject(matchingBucket)?.skills) ?? readArray(resultRecord?.skills) ?? [];

  return rawSkills.flatMap((value) => {
    const skill = readObject(value);
    const display = readObject(skill?.interface);
    const name = nonEmptyTrimmed(skill?.name);
    const path = nonEmptyTrimmed(skill?.path);
    if (!name || !path) {
      return [];
    }

    return [
      {
        name,
        path,
        enabled: skill?.enabled !== false,
        ...(nonEmptyTrimmed(skill?.description)
          ? { description: nonEmptyTrimmed(skill?.description) }
          : {}),
        ...(nonEmptyTrimmed(skill?.scope) ? { scope: nonEmptyTrimmed(skill?.scope) } : {}),
        ...(nonEmptyTrimmed(display?.displayName)
          ? { displayName: nonEmptyTrimmed(display?.displayName) }
          : {}),
        ...(nonEmptyTrimmed(skill?.shortDescription) || nonEmptyTrimmed(display?.shortDescription)
          ? {
              shortDescription:
                nonEmptyTrimmed(skill?.shortDescription) ??
                nonEmptyTrimmed(display?.shortDescription),
            }
          : {}),
      } satisfies ServerProviderSkill,
    ];
  });
}

export function buildCodexInitializeParams() {
  return {
    clientInfo: {
      name: "t3code_desktop",
      title: "T3 Code Desktop",
      version: "0.1.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  } as const;
}

export function killCodexChildProcess(child: ChildProcessWithoutNullStreams): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      return;
    } catch {
      // Fall through to direct kill when taskkill is unavailable.
    }
  }

  child.kill();
}

export async function probeCodexDiscovery(input: {
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}): Promise<CodexDiscoverySnapshot> {
  return await new Promise((resolve, reject) => {
    const child = spawn(input.binaryPath, ["app-server"], {
      env: {
        ...process.env,
        ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const output = readline.createInterface({ input: child.stdout });

    let completed = false;
    let account: CodexAccountSnapshot | undefined;
    let skills: ReadonlyArray<ServerProviderSkill> | undefined;

    const cleanup = () => {
      output.removeAllListeners();
      output.close();
      child.removeAllListeners();
      if (!child.killed) {
        killCodexChildProcess(child);
      }
    };

    const finish = (callback: () => void) => {
      if (completed) return;
      completed = true;
      cleanup();
      callback();
    };

    const fail = (error: unknown) =>
      finish(() =>
        reject(
          error instanceof Error
            ? error
            : new Error(`Codex discovery probe failed: ${String(error)}.`),
        ),
      );

    const maybeResolve = () => {
      if (account && skills !== undefined) {
        const resolvedAccount = account;
        const resolvedSkills = skills;
        finish(() => resolve({ account: resolvedAccount, skills: resolvedSkills }));
      }
    };

    if (input.signal?.aborted) {
      fail(new Error("Codex discovery probe aborted."));
      return;
    }
    input.signal?.addEventListener("abort", () =>
      fail(new Error("Codex discovery probe aborted.")),
    );

    const writeMessage = (message: unknown) => {
      if (!child.stdin.writable) {
        fail(new Error("Cannot write to codex app-server stdin."));
        return;
      }

      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    output.on("line", (line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(new Error("Received invalid JSON from codex app-server during discovery probe."));
        return;
      }

      if (!parsed || typeof parsed !== "object") {
        return;
      }

      const response = parsed as JsonRpcProbeResponse;
      if (response.id === 1) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`initialize failed: ${errorMessage}`));
          return;
        }

        writeMessage({ method: "initialized" });
        writeMessage({ id: 2, method: "skills/list", params: { cwds: [input.cwd] } });
        writeMessage({ id: 3, method: "account/read", params: {} });
        return;
      }

      if (response.id === 2) {
        const errorMessage = readErrorMessage(response);
        skills = errorMessage ? [] : parseCodexSkillsResult(response.result, input.cwd);
        maybeResolve();
        return;
      }

      if (response.id === 3) {
        const errorMessage = readErrorMessage(response);
        if (errorMessage) {
          fail(new Error(`account/read failed: ${errorMessage}`));
          return;
        }

        account = readCodexAccountSnapshot(response.result);
        maybeResolve();
      }
    });

    child.once("error", fail);
    child.once("exit", (code, signal) => {
      if (completed) return;
      fail(
        new Error(
          `codex app-server exited before probe completed (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
        ),
      );
    });

    writeMessage({
      id: 1,
      method: "initialize",
      params: buildCodexInitializeParams(),
    });
  });
}
