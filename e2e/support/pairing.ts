// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - runs inside e2e tests, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

import type { App } from "e2e";
import type { Browser } from "@e2e-dev/web";
import { expect } from "e2e";

import { SERVER_BIN, instancePathsForBaseUrl, isolatedEnv } from "./instance.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

/** Runs the T3 CLI against the isolated server behind `baseUrl` and returns its stdout. */
export async function runT3Cli(baseUrl: string | undefined, args: ReadonlyArray<string>) {
  const paths = instancePathsForBaseUrl(baseUrl);
  const { stdout } = await execFile(
    process.execPath,
    [SERVER_BIN, ...args, "--base-dir", paths.t3Home],
    { env: isolatedEnv(paths) },
  );
  return stdout;
}

/** Mints a one-time pairing token with standard client scopes on the server behind `baseUrl`. */
export async function mintPairingToken(baseUrl: string | undefined): Promise<string> {
  const issued: { credential: string } = JSON.parse(
    await runT3Cli(baseUrl, ["auth", "pairing", "create", "--json"]),
  );
  return issued.credential;
}

/** Signs this browser in with a fresh pairing token, like a newly paired device. */
export async function pairBrowser(app: App, browser: Browser) {
  const token = await mintPairingToken(app.baseUrl);
  await app.open(`/pair#${new URLSearchParams([["token", token]]).toString()}`);
  await expect(browser).not.toHaveURL(/\/pair/);
}
