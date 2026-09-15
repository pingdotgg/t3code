/**
 * OpenCode Go subscription usage. The `GET /zen/go/v1/usage` console endpoint
 * answers with the same bearer key opencode itself uses for completions, so
 * one mapper serves the status probe; the Go key is read fresh from opencode's
 * own `auth.json` on every probe and never stored or logged.
 *
 * @module provider/Layers/openCodeGoUsageLimits
 */
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { resolveOpenCodeDataDir } from "../openCodePaths.ts";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

const OPENCODE_GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

const OpenCodeGoUsageWindow = Schema.Struct({
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  resetsAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const OpenCodeGoUsageResponse = Schema.Struct({
  usage: Schema.Struct({
    rolling: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindow)),
    weekly: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindow)),
    monthly: Schema.optional(Schema.NullOr(OpenCodeGoUsageWindow)),
  }),
});
const decodeOpenCodeGoUsage = Schema.decodeUnknownEffect(OpenCodeGoUsageResponse);

// Each service in auth.json carries its own credential shape (Go uses an API
// key, ChatGPT OAuth uses tokens), so only the Go entry is decoded strictly.
const OpenCodeAuthFile = Schema.Record(
  Schema.String,
  Schema.Struct({ key: Schema.optional(Schema.String) }),
);
const decodeOpenCodeAuthFile = Schema.decodeUnknownOption(OpenCodeAuthFile);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

function openCodeGoApiKeyFromAuthFile(value: unknown): string | null {
  const decoded = decodeOpenCodeAuthFile(value);
  if (decoded._tag === "None") return null;
  const key = decoded.value["opencode-go"]?.key;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function isoDateTime(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

/**
 * The endpoint reports whole percentages (7 means 7%), one per window, each
 * with an ISO reset timestamp. A window without a finite percent carries no
 * reading and is left out rather than shown as zero.
 */
export function openCodeGoUsageToLimits(input: {
  readonly response: typeof OpenCodeGoUsageResponse.Type;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const positions = [
    {
      id: "go_rolling",
      kind: "session",
      label: "Session",
      windowDurationMins: 300,
      window: input.response.usage.rolling,
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 10_080,
      window: input.response.usage.weekly,
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Monthly",
      windowDurationMins: 43_200,
      window: input.response.usage.monthly,
    },
  ] as const;
  return makeUsageLimits({
    checkedAt: input.checkedAt,
    windows: positions.flatMap(({ id, kind, label, windowDurationMins, window }) => {
      if (!window) return [];
      const percent = window.percent;
      if (typeof percent !== "number" || !Number.isFinite(percent)) return [];
      const resetsAt = isoDateTime(window.resetsAt);
      return [
        {
          id,
          kind,
          label,
          usedPercent: clampPercent(percent),
          windowDurationMins,
          ...(resetsAt ? { resetsAt } : {}),
        },
      ];
    }),
  });
}

/** auth.json exists but could not be read or decoded, which is not the same as having no Go entry. */
const UNREADABLE = Symbol("unreadable");

const readGoApiKey = Effect.fn("openCodeGoUsageLimits.readGoApiKey")(function* (
  environment: NodeJS.ProcessEnv | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const raw = yield* fileSystem
    .readFileString(path.join(resolveOpenCodeDataDir(environment), "auth.json"))
    .pipe(
      Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : UNREADABLE)),
    );
  if (raw === null || raw === UNREADABLE) return raw;
  const parsed = decodeJson(raw);
  return parsed._tag === "None" ? UNREADABLE : openCodeGoApiKeyFromAuthFile(parsed.value);
});

/**
 * Reads the Go subscription windows for the status probe. Returns undefined
 * when this machine has no Go subscription, so the probe leaves whatever the
 * provider already publishes untouched. A failed read reports probeFailed and
 * keeps the last good snapshot instead of clearing the bars.
 */
export const readOpenCodeGoUsageLimits = Effect.fn("readOpenCodeGoUsageLimits")(function* (input: {
  readonly environment?: NodeJS.ProcessEnv;
  readonly checkedAt: string;
}): Effect.fn.Return<
  ServerProviderUsageLimits | undefined,
  never,
  FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
> {
  const apiKey = yield* readGoApiKey(input.environment);
  if (apiKey === null) return undefined;
  if (apiKey === UNREADABLE) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: "Could not read opencode's auth.json to check the OpenCode Go quota.",
    });
  }
  const client = yield* HttpClient.HttpClient;
  const request = HttpClientRequest.get(OPENCODE_GO_USAGE_URL).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey}`),
  );
  const result = yield* client.execute(request).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeOpenCodeGoUsage),
    Effect.timeout("10 seconds"),
    Effect.map((response) => openCodeGoUsageToLimits({ response, checkedAt: input.checkedAt })),
    Effect.catch((error) => {
      const rejected =
        error._tag === "HttpClientError" &&
        error.reason._tag === "StatusCodeError" &&
        (error.reason.response.status === 401 || error.reason.response.status === 403);
      return Effect.logDebug("OpenCode Go usage request failed.", { rejected }).pipe(
        Effect.as(
          rejected
            ? "OpenCode Go rejected its API key. Reconnect it with /connect to refresh access."
            : "OpenCode Go did not return a readable usage response.",
        ),
      );
    }),
  );
  if (typeof result === "string" || result.windows.length === 0) {
    return makeUnavailableUsageLimits({
      checkedAt: input.checkedAt,
      reason: "probeFailed",
      message: typeof result === "string" ? result : "OpenCode Go returned no limit windows.",
    });
  }
  return result;
});
