// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Spawning the local Cua Driver CLI requires Node child_process.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const encodeJsonUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const BLOCKED_BROWSER_TOOLS = new Set(["get_browser_state"]);

export interface CuaCallOptions {
  readonly timeoutMs?: number | undefined;
  readonly saveScreenshot?: boolean | undefined;
}

export interface CuaCallResult {
  readonly result: unknown;
  readonly screenshotPath?: string | undefined;
}

export interface CuaDriverShape {
  readonly platform: NodeJS.Platform;
  readonly call: (
    tool: string,
    args: Readonly<Record<string, unknown>>,
    options?: CuaCallOptions,
  ) => Effect.Effect<CuaCallResult, OrchestratorMcpFailure>;
}

export class CuaDriver extends Context.Service<CuaDriver, CuaDriverShape>()(
  "t3/mcp/toolkits/cu/cuaDriver",
) {}

export function isBlockedBrowserTool(tool: string): boolean {
  return tool.startsWith("browser_") || BLOCKED_BROWSER_TOOLS.has(tool);
}

interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runCuaProcess(
  cliArgs: ReadonlyArray<string>,
  stdinText: string | undefined,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("cua-driver", cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: HostProcess.Environment.defaultValue(),
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      });
    });

    if (stdinText !== undefined) {
      child.stdin.write(stdinText);
    }
    child.stdin.end();
  });
}

function parseOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return { text: stdout };
  }
}

export const layerLive = Layer.effect(
  CuaDriver,
  Effect.map(HostProcess.Platform, (platform) =>
    CuaDriver.of({
      platform,
      call: Effect.fn("CuaDriver.call")(function* (tool, args, options) {
        if (isBlockedBrowserTool(tool)) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Tool '${tool}' is for Chrome browser automation; use T3 preview_* tools instead.`,
          });
        }
        const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let cliArgs: string[];
        let stdinText: string | undefined;
        let screenshotPath: string | undefined;

        if (tool === "permissions_status") {
          cliArgs = ["permissions", "status", "--json"];
        } else if (tool === "describe") {
          const targetTool = typeof args.tool === "string" ? args.tool.trim() : "";
          if (targetTool.length === 0) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "tool='describe' requires args.tool (the cua-driver tool name to describe).",
            });
          }
          if (isBlockedBrowserTool(targetTool)) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: `Tool '${targetTool}' is for Chrome browser automation; use T3 preview_* tools instead.`,
            });
          }
          cliArgs = ["describe", targetTool];
        } else {
          cliArgs = ["call"];
          if (options?.saveScreenshot === true) {
            const dir = NodePath.join(NodeOS.tmpdir(), "t3-cu-screenshots");
            yield* Effect.tryPromise({
              try: () => NodeFSP.mkdir(dir, { recursive: true }),
              catch: (cause) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: `Could not create screenshot directory: ${cause instanceof Error ? cause.message : String(cause)}`,
                }),
            });
            screenshotPath = NodePath.join(dir, `cu-${NodeCrypto.randomUUID()}.png`);
            cliArgs.push("--screenshot-out-file", screenshotPath);
          }
          cliArgs.push(tool);
          stdinText = yield* encodeJsonUnknown(args).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({
                  code: "invalid_request",
                  message: `Arguments for cua-driver ${tool} are not JSON-serializable: ${String(cause)}`,
                }),
            ),
          );
        }

        const outcome = yield* Effect.tryPromise({
          try: () => runCuaProcess(cliArgs, stdinText, timeoutMs),
          catch: (cause) => {
            const code =
              typeof cause === "object" && cause !== null && "code" in cause
                ? String((cause as { code?: unknown }).code)
                : "";
            return new OrchestratorMcpFailure({
              code: "orchestration_error",
              message:
                code === "ENOENT"
                  ? "cua-driver is not installed or not on PATH."
                  : `Failed to run cua-driver: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
          },
        });

        if (outcome.timedOut) {
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `cua-driver ${tool} timed out after ${timeoutMs}ms.`,
          });
        }
        if (outcome.code !== 0) {
          const detail = outcome.stderr.trim() || outcome.stdout.trim() || `exit ${outcome.code}`;
          return yield* new OrchestratorMcpFailure({
            code: "orchestration_error",
            message: `cua-driver ${tool} failed: ${detail}`,
          });
        }

        const savedScreenshot =
          screenshotPath !== undefined && NodeFS.existsSync(screenshotPath)
            ? screenshotPath
            : undefined;
        return {
          result: parseOutput(outcome.stdout),
          ...(savedScreenshot === undefined ? {} : { screenshotPath: savedScreenshot }),
        };
      }),
    }),
  ),
);
