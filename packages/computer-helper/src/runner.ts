// Ported from LocalRouter (github.com/jayleaton/localrouter @fe24726, apps/desktop-helper/src/computer/runner.ts), modified for Ada.
import * as NodeChildProcess from "node:child_process";

/** `input`: written to the child's stdin; `signal`: kills the child (a stop); `timeoutMs`: kills it after that long. */
export type CommandOptions = {
  input?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

/** Runs one executable with argv (no shell); resolves stdout and rejects on a non-zero exit. */
export interface CommandRunner {
  run(file: string, args: string[], options?: CommandOptions): Promise<string>;
}

/** The reason a run was aborted, when it is words (the controller aborts with the sentence for the person). */
const abortMessage = (signal: AbortSignal) =>
  typeof signal.reason === "string" && signal.reason ? signal.reason : "It was stopped.";

/**
 * A runner over execFile. On failure only the child's stderr is kept (the message of execFile repeats the whole
 * argv, which for an inline script is the script itself); `slow` names the program in the timeout message.
 */
export function execRunner(defaults: {
  timeoutMs: number;
  maxBuffer?: number;
  slow?: string;
}): CommandRunner {
  return {
    run(file, args, options = {}) {
      const signal = options.signal;
      if (signal?.aborted) return Promise.reject(new Error(abortMessage(signal)));
      return new Promise((resolve, reject) => {
        const child = NodeChildProcess.execFile(
          file,
          args,
          {
            timeout: options.timeoutMs ?? defaults.timeoutMs,
            maxBuffer: defaults.maxBuffer ?? 8 * 1024 * 1024,
            windowsHide: true,
            ...(signal ? { signal } : {}),
            ...(options.env ? { env: options.env } : {}),
          },
          (error, stdout, stderr) => {
            if (!error) return resolve(String(stdout));
            if (signal?.aborted) return reject(new Error(abortMessage(signal)));
            const killed = (error as { killed?: boolean }).killed === true;
            const said = String(stderr ?? "").trim();
            reject(
              new Error(
                killed
                  ? `${defaults.slow ?? file} took too long to answer (timed out)`
                  : said || error.message,
              ),
            );
          },
        );
        if (options.input !== undefined) child.stdin?.end(options.input);
        else child.stdin?.end();
      });
    },
  };
}
