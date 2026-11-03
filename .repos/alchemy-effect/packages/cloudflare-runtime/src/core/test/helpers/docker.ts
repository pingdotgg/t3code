import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as Effect from "effect/Effect";

const execFileAsync = promisify(execFile);

export const DOCKER_BIN = process.env.DOCKER_BIN ?? "docker";

/**
 * Run the docker CLI and return its stdout. Asynchronous and killed on
 * interruption, so a stalled daemon fails the test at its timeout instead of
 * blocking the worker's event loop (as `execFileSync` would) until the
 * daemon recovers.
 */
export const docker = (...args: Array<string>) =>
  Effect.tryPromise((signal) =>
    execFileAsync(DOCKER_BIN, args, { encoding: "utf8", signal }).then(({ stdout }) => stdout),
  );
