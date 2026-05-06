import { createInterface } from "node:readline/promises";

import type { CheckContext } from "../registry";
import type { CheckResult } from "../result";
import type { PreflightDeps } from "../checks/support";
import { checkResult, ok } from "../checks/support";

export type GuidedFetchRequest = {
  key: string;
  providerUrl: string;
  validate: (value: string) => boolean;
};

export const validateProviderValue = (request: GuidedFetchRequest, value: string): boolean =>
  value.trim() !== "" && request.validate(value.trim());

export const guidedFetchHint = (request: GuidedFetchRequest): string =>
  `Open ${request.providerUrl}, copy ${request.key}, then rerun preflight in an interactive TTY.`;

const isInteractive = (deps: PreflightDeps): boolean =>
  deps.env.PREFLIGHT_TTY === "1" || process.stdin.isTTY === true;

const promptProviderValue = async (request: GuidedFetchRequest): Promise<string> => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(`Paste ${request.key} from ${request.providerUrl}: `);
  } finally {
    terminal.close();
  }
};

export const guidedFetchSecret = async (
  context: CheckContext,
  deps: PreflightDeps,
  request: GuidedFetchRequest,
  readValue: (request: GuidedFetchRequest) => Promise<string> = promptProviderValue,
): Promise<CheckResult> => {
  const startedAt = Date.now();
  if (!isInteractive(deps)) {
    return checkResult(
      `fix/guided-fetch/${request.key}`,
      `Fetch ${request.key}`,
      "error",
      startedAt,
      {
        hint: guidedFetchHint(request),
      },
    );
  }

  const value = (await readValue(request)).trim();
  if (!validateProviderValue(request, value)) {
    return checkResult(
      `fix/guided-fetch/${request.key}`,
      `Fetch ${request.key}`,
      "error",
      startedAt,
      {
        hint: `${request.key} did not match the expected provider format; Doppler was not changed.`,
      },
    );
  }

  const written = await deps.run({
    cmd: "doppler",
    args: ["secrets", "set", request.key, "--no-interactive", "--silent"],
    cwd: context.cwd,
    timeoutMs: context.timeoutMs,
    input: value,
  });

  return checkResult(
    `fix/guided-fetch/${request.key}`,
    `Fetch ${request.key}`,
    ok(written) ? "pass" : "error",
    startedAt,
    {
      hint: ok(written)
        ? `${request.key} written via Doppler stdin.`
        : `Failed to write ${request.key} via Doppler stdin.`,
    },
  );
};
