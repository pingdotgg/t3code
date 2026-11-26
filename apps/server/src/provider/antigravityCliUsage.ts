import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";
import { isCommandMissingCause } from "./providerSnapshot.ts";
import { makeUnavailableUsageLimits, makeUsageLimits } from "./providerUsageLimits.ts";

const REMOVED_ENVIRONMENT_KEYS = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

const UsageOutput = Schema.Struct({
  command: Schema.Struct({
    data: Schema.Struct({
      groups: Schema.Array(
        Schema.Struct({
          id: Schema.optional(Schema.String),
          name: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
          buckets: Schema.Array(
            Schema.Struct({
              window: Schema.optional(Schema.String),
              remaining_fraction: Schema.optional(Schema.Finite),
              reset_time: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    }),
  }),
});

const decodeUsageOutput = Schema.decodeUnknownOption(Schema.fromJsonString(UsageOutput));

function usageWindowKind(window: string | undefined): ServerProviderUsageWindow["kind"] {
  const normalized = window?.toLowerCase();
  if (normalized?.includes("week")) return "weekly";
  if (normalized?.includes("month")) return "monthly";
  if (normalized?.includes("5h") || normalized?.includes("hour")) return "session";
  return "other";
}

function usageWindowDuration(window: string | undefined): number | undefined {
  const kind = usageWindowKind(window);
  if (kind === "session") return 5 * 60;
  if (kind === "weekly") return 7 * 24 * 60;
  if (kind === "monthly") return 30 * 24 * 60;
  return undefined;
}

function parseResetTime(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

export function parseAntigravityCliUsage(
  output: string,
  checkedAt: string,
): ServerProviderUsageLimits | undefined {
  const decoded = decodeUsageOutput(output);
  if (Option.isNone(decoded)) return undefined;

  const windows: ServerProviderUsageWindow[] = [];
  for (const group of decoded.value.command.data.groups) {
    for (const [index, bucket] of group.buckets.entries()) {
      if (
        typeof bucket.remaining_fraction !== "number" ||
        !Number.isFinite(bucket.remaining_fraction) ||
        bucket.remaining_fraction < 0 ||
        bucket.remaining_fraction > 1
      ) {
        continue;
      }
      const kind = usageWindowKind(bucket.window);
      const groupName = group.title ?? group.name ?? group.id ?? "Antigravity";
      const windowName = bucket.window ?? `bucket-${index + 1}`;
      const resetsAt = parseResetTime(bucket.reset_time);
      windows.push({
        id: `${group.id ?? groupName}:${windowName}`,
        kind,
        label: `${groupName} · ${windowName}`,
        usedPercent: (1 - bucket.remaining_fraction) * 100,
        ...(usageWindowDuration(bucket.window) !== undefined
          ? { windowDurationMins: usageWindowDuration(bucket.window) }
          : {}),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }

  return windows.length > 0 ? makeUsageLimits({ checkedAt, windows }) : undefined;
}

/**
 * Read the CLI's own read-only `/usage` command. It returns zero model tokens,
 * but still starts the standalone CLI and may contact Google's quota service.
 */
export const readAntigravityCliUsage = Effect.fn("readAntigravityCliUsage")(function* (input: {
  readonly profileDirectory: string;
  readonly baseEnvironment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const environment: NodeJS.ProcessEnv = {
    ...Object.fromEntries(
      Object.entries(input.baseEnvironment).filter(
        ([key]) => !REMOVED_ENVIRONMENT_KEYS.has(key.toUpperCase()),
      ),
    ),
    // Keep CLI credentials in this provider instance's profile and prevent a quota refresh
    // from updating the user's installed CLI as a side effect.
    GEMINI_HOME: input.profileDirectory,
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    AGY_CLI_FORCE_FILE_TOKEN_STORAGE: "true",
  };
  const probe = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const args = [
      "--print",
      "/usage",
      "--output-format",
      "json",
      "--print-timeout",
      "10s",
      "--log-file",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ];
    const resolved = yield* resolveSpawnCommand("agy", args, { env: environment });
    const child = yield* spawner.spawn(
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        extendEnv: false,
        shell: resolved.shell,
      }),
    );
    const [stdout, exitCode] = yield* Effect.all(
      [
        collectUint8StreamText({ stream: child.stdout, maxBytes: 256 * 1024 }),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    if (exitCode !== 0 || stdout.truncated) {
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity could not read usage from the official CLI.",
      });
    }
    return (
      parseAntigravityCliUsage(stdout.text, checkedAt) ??
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Antigravity returned an unrecognized usage response.",
      })
    );
  }).pipe(Effect.scoped, Effect.timeoutOption("15 seconds"));
  const result = yield* probe.pipe(Effect.result);
  if (Result.isSuccess(result) && Option.isSome(result.success)) return result.success.value;
  const missingCli = Result.isFailure(result) && isCommandMissingCause(result.failure);
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: missingCli
      ? "Install the official Antigravity CLI (`agy`) to read quota limits."
      : "Antigravity could not read usage from the official CLI.",
  });
});
