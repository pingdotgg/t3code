// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off -- Owns an IPC subprocess and its startup deadline.
import * as NodeChildProcess from "node:child_process";
import type { UsageProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { serverSubcommand } from "../cli/serverSubcommand.ts";
import type { TranscriptParsePosition, TranscriptParseResult } from "./usageTranscriptReader.ts";

export type TranscriptWorkerMessage =
  | { readonly ready: true }
  | { readonly result: TranscriptParseResult | null };

export interface TranscriptParseJob {
  readonly path: string;
  readonly provider: UsageProviderKind;
  readonly resumeFrom: TranscriptParsePosition | undefined;
}

// Startup loads the server entry module before publishing readiness.
const WORKER_READY_MS = 10_000;

/** Owns readiness, one in-flight protocol exchange and process teardown. */
export function makeUsageTranscriptWorker(
  command: Effect.Success<ReturnType<typeof serverSubcommand>>,
) {
  const child = NodeChildProcess.spawn(command.executable, command.args, {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    windowsHide: true,
    env: command.env,
  });
  const ready = Promise.withResolvers<boolean>();
  const exited = Promise.withResolvers<void>();
  let reply: ((result: TranscriptParseResult | null | undefined) => void) | undefined;
  let unavailable = false;
  let initialized = false;
  const settle = (result: TranscriptParseResult | null | undefined) => {
    const pending = reply;
    reply = undefined;
    pending?.(result);
  };
  const stop = () => {
    if (unavailable) return exited.promise;
    unavailable = true;
    clearTimeout(readyTimer);
    ready.resolve(false);
    settle(undefined);
    child.kill();
    return exited.promise;
  };
  const readyTimer = setTimeout(() => void stop(), WORKER_READY_MS);
  readyTimer.unref();
  child.once("exit", () => {
    unavailable = true;
    clearTimeout(readyTimer);
    ready.resolve(false);
    settle(undefined);
    exited.resolve();
  });
  // A failed spawn has no exit event; later IPC errors still need a listener.
  child.on("error", () => {
    void stop();
    if (child.pid === undefined) exited.resolve();
  });
  child.once("disconnect", () => void stop());
  child.on("message", (message: unknown) => {
    if (unavailable) return;
    if (typeof message === "object" && message !== null) {
      if (!initialized && "ready" in message && message.ready === true) {
        initialized = true;
        clearTimeout(readyTimer);
        ready.resolve(true);
        return;
      }
      if (initialized && reply !== undefined && "result" in message) {
        const result = message.result;
        if (
          result === null ||
          (typeof result === "object" &&
            result !== null &&
            "records" in result &&
            Array.isArray(result.records) &&
            "tailRecords" in result &&
            Array.isArray(result.tailRecords) &&
            "malformedRecords" in result &&
            typeof result.malformedRecords === "number" &&
            "resumed" in result &&
            typeof result.resumed === "boolean" &&
            "position" in result &&
            typeof result.position === "object" &&
            result.position !== null &&
            "resumeOffset" in result.position &&
            typeof result.position.resumeOffset === "number" &&
            "guardLength" in result.position &&
            typeof result.position.guardLength === "number" &&
            "guardHash" in result.position &&
            typeof result.position.guardHash === "number" &&
            "state" in result.position)
        ) {
          settle(result as TranscriptParseResult | null);
          return;
        }
      }
    }
    // A malformed or unpaired message makes subsequent replies untrustworthy.
    void stop();
  });
  const parse = (job: TranscriptParseJob) =>
    Effect.callback<TranscriptParseResult | null | undefined>((resume) => {
      if (unavailable || !initialized || !child.connected) {
        resume(Effect.undefined);
        return;
      }
      reply = (result) => resume(Effect.succeed(result));
      try {
        child.send(job, (error) => {
          if (error) void stop();
        });
      } catch {
        void stop();
      }
    });
  return { ready: ready.promise, exited: exited.promise, parse, stop };
}

export type UsageTranscriptWorker = ReturnType<typeof makeUsageTranscriptWorker>;
