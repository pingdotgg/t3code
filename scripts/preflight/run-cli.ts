import { spawn } from "node:child_process";

export type RunCliOptions = {
  cmd: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  input?: string;
};

export type RunCliResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export const runCli = async (options: RunCliOptions): Promise<RunCliResult> =>
  await new Promise((resolve) => {
    const child = spawn(options.cmd, options.args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: ReturnType<typeof setTimeout>;

    const settle = (result: RunCliResult): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    timeout = setTimeout(() => {
      child.kill("SIGTERM");
      settle({ exitCode: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }

    child.on("close", (exitCode) => {
      settle({ exitCode, stdout, stderr, timedOut: false });
    });

    child.on("error", (error) => {
      settle({ exitCode: null, stdout, stderr: error.message, timedOut: false });
    });
  });
