/**
 * ClaudeUsage — account-level subscription usage for the Claude driver.
 *
 * Reads the Claude Code OAuth token from `<home>/.claude/.credentials.json`
 * (the same HOME the driver runs the CLI with) and calls Anthropic's
 * OAuth usage endpoint. The endpoint is undocumented and shared with Claude
 * Code itself, so the response is parsed leniently: unknown fields are
 * ignored, model-scoped window labels come from the response verbatim
 * (model names are renamed upstream without notice), and shape drift
 * degrades to fewer windows rather than an error.
 *
 * Deliberate v1 boundaries:
 *   - Credentials-file only. No macOS Keychain fallback — server nodes are
 *     typically headless Linux; a missing file is surfaced as
 *     `unauthenticated` with CLI login guidance.
 *   - No OAuth token refresh. Writing a rotated refresh token back would
 *     race Claude Code's own refresh; an expired token is reported as
 *     `unauthenticated` and heals the next time the CLI runs.
 *
 * @module provider/Layers/ClaudeUsage
 */
import type {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageCredits,
  ProviderUsageSnapshot,
  ProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import type { ProviderUsageShape } from "../Services/ProviderUsage.ts";
import { resolveClaudeHomePath } from "../Drivers/ClaudeHome.ts";
import { claudeSubscriptionLabel } from "./ClaudeProvider.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA_HEADER = "oauth-2025-04-20";
// The usage endpoint is only served to Claude Code's own OAuth client, so
// present as a recent CLI build the same way other local usage tools do.
const CLAUDE_USAGE_USER_AGENT = "claude-code/2.1.0";
const CLAUDE_USAGE_TIMEOUT = Duration.seconds(15);
const CLAUDE_PROFILE_SCOPE = "user:profile";

const SIGN_IN_MESSAGE = "Sign in with the `claude` CLI on the server machine.";

export interface ClaudeUsageMeta {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string | undefined;
}

interface ClaudeOauthCredentials {
  readonly accessToken: string;
  readonly expiresAt: number | undefined;
  readonly subscriptionType: string | undefined;
  readonly scopes: ReadonlyArray<string> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

export function parseClaudeOauthCredentials(raw: unknown): ClaudeOauthCredentials | undefined {
  if (!isRecord(raw)) return undefined;
  const oauth = raw["claudeAiOauth"];
  if (!isRecord(oauth)) return undefined;
  const accessToken = stringField(oauth, "accessToken");
  if (!accessToken) return undefined;
  const scopes = oauth["scopes"];
  return {
    accessToken,
    expiresAt: numberField(oauth, "expiresAt"),
    subscriptionType: stringField(oauth, "subscriptionType"),
    scopes:
      Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string")
        ? scopes
        : undefined,
  };
}

const WEEK_MINUTES = 7 * 24 * 60;
const SESSION_WINDOW_MINUTES = 5 * 60;

function usageWindowFromJson(input: {
  readonly raw: unknown;
  readonly id: string;
  readonly label: string;
  readonly kind: ProviderUsageWindow["kind"];
  readonly windowMinutes: number | undefined;
}): ProviderUsageWindow | undefined {
  if (!isRecord(input.raw)) return undefined;
  const utilization = numberField(input.raw, "utilization");
  if (utilization === undefined) return undefined;
  const resetsAt = stringField(input.raw, "resets_at");
  return {
    id: input.id,
    label: input.label,
    kind: input.kind,
    usedPercent: clampPercent(utilization),
    ...(resetsAt ? { resetsAt } : {}),
    ...(input.windowMinutes !== undefined ? { windowMinutes: input.windowMinutes } : {}),
  };
}

/**
 * Map the raw `/api/oauth/usage` JSON to normalized windows + credits.
 * Exported for fixture-driven tests. Every field is optional — unknown or
 * missing pieces produce fewer windows, never a failure.
 */
export function mapClaudeUsageResponse(raw: unknown): {
  readonly windows: ReadonlyArray<ProviderUsageWindow>;
  readonly credits: ProviderUsageCredits | undefined;
} {
  if (!isRecord(raw)) return { windows: [], credits: undefined };

  const windowsById = new Map<string, ProviderUsageWindow>();
  const addWindow = (window: ProviderUsageWindow | undefined) => {
    if (window && !windowsById.has(window.id)) windowsById.set(window.id, window);
  };

  addWindow(
    usageWindowFromJson({
      raw: raw["five_hour"],
      id: "five_hour",
      label: "Session",
      kind: "session",
      windowMinutes: SESSION_WINDOW_MINUTES,
    }),
  );
  addWindow(
    usageWindowFromJson({
      raw: raw["seven_day"],
      id: "seven_day",
      label: "Weekly",
      kind: "weekly",
      windowMinutes: WEEK_MINUTES,
    }),
  );

  // Model-scoped weekly windows appear both as `seven_day_<model>` keys and
  // as `limits[]` entries depending on account/era. Labels are derived from
  // the payload (key suffix or display name) — never hardcoded model names.
  for (const [key, value] of Object.entries(raw)) {
    const match = /^seven_day_(.+)$/.exec(key);
    if (!match) continue;
    const modelSlug = match[1]!;
    addWindow(
      usageWindowFromJson({
        raw: value,
        id: `model:${modelSlug.toLowerCase()}`,
        label: toTitleCaseWords(modelSlug),
        kind: "model",
        windowMinutes: WEEK_MINUTES,
      }),
    );
  }

  const limits = raw["limits"];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!isRecord(entry)) continue;
      const scope = entry["scope"];
      const model = isRecord(scope) ? scope["model"] : undefined;
      const displayName = isRecord(model) ? stringField(model, "display_name") : undefined;
      if (!displayName) continue;
      const percent = numberField(entry, "percent");
      if (percent === undefined) continue;
      const resetsAt = stringField(entry, "resets_at");
      addWindow({
        id: `model:${displayName.toLowerCase()}`,
        label: displayName,
        kind: "model",
        usedPercent: clampPercent(percent),
        ...(resetsAt ? { resetsAt } : {}),
        windowMinutes: WEEK_MINUTES,
      });
    }
  }

  let credits: ProviderUsageCredits | undefined;
  const extraUsage = raw["extra_usage"];
  if (isRecord(extraUsage) && extraUsage["is_enabled"] === true) {
    const usedCents = numberField(extraUsage, "used_credits");
    const limitCents = numberField(extraUsage, "monthly_limit");
    credits = {
      label: "Extra usage",
      ...(usedCents !== undefined ? { usedCredits: usedCents / 100 } : {}),
      ...(limitCents !== undefined ? { monthlyLimit: limitCents / 100 } : {}),
    };
  }

  return { windows: Array.from(windowsById.values()), credits };
}

/**
 * Build the usage capability for one Claude instance. Captures the
 * infrastructure services at create time so `fetchUsage` runs with
 * `R = never`, matching the other instance shapes.
 */
export const makeClaudeUsage = Effect.fn("makeClaudeUsage")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  meta: ClaudeUsageMeta,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ProviderUsageShape,
  never,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const homePath = yield* resolveClaudeHomePath(config, environment);
  const credentialsPath = path.join(homePath, ".claude", ".credentials.json");

  const fetchUsage = Effect.gen(function* () {
    const fetchedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      instanceId: meta.instanceId,
      driver: meta.driverKind,
      ...(meta.displayName ? { displayName: meta.displayName } : {}),
      windows: [],
      fetchedAt,
    } satisfies Partial<ProviderUsageSnapshot> & { windows: ReadonlyArray<ProviderUsageWindow> };
    const failed = (
      status: "unauthenticated" | "error",
      message: string,
    ): ProviderUsageSnapshot => ({ ...base, status, message });

    const rawCredentials = yield* fs.readFileString(credentialsPath).pipe(Effect.result);
    if (Result.isFailure(rawCredentials)) {
      return failed("unauthenticated", SIGN_IN_MESSAGE);
    }
    const credentialsJson = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      rawCredentials.success,
    ).pipe(Effect.result);
    if (Result.isFailure(credentialsJson)) {
      return failed("unauthenticated", SIGN_IN_MESSAGE);
    }
    const credentials = parseClaudeOauthCredentials(credentialsJson.success);
    if (!credentials) {
      return failed("unauthenticated", SIGN_IN_MESSAGE);
    }

    const now = yield* DateTime.now;
    if (
      credentials.expiresAt !== undefined &&
      credentials.expiresAt <= DateTime.toEpochMillis(now)
    ) {
      return failed(
        "unauthenticated",
        "Claude token expired — it refreshes the next time Claude runs on this machine.",
      );
    }
    if (credentials.scopes && !credentials.scopes.includes(CLAUDE_PROFILE_SCOPE)) {
      return failed(
        "unauthenticated",
        "The stored Claude token cannot read usage — sign in again with a recent `claude` CLI (a full login, not `claude setup-token`).",
      );
    }

    const planLabel = claudeSubscriptionLabel(credentials.subscriptionType);
    const request = HttpClientRequest.get(CLAUDE_USAGE_URL).pipe(
      HttpClientRequest.bearerToken(credentials.accessToken),
      HttpClientRequest.setHeader("anthropic-beta", CLAUDE_OAUTH_BETA_HEADER),
      HttpClientRequest.setHeader("user-agent", CLAUDE_USAGE_USER_AGENT),
      HttpClientRequest.acceptJson,
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.timeoutOption(CLAUDE_USAGE_TIMEOUT), Effect.result);
    if (Result.isFailure(response)) {
      return failed("error", `Claude usage request failed: ${String(response.failure)}`);
    }
    if (Option.isNone(response.success)) {
      return failed("error", "Claude usage request timed out.");
    }
    const httpResponse = response.success.value;
    if (httpResponse.status === 401 || httpResponse.status === 403) {
      return failed(
        "unauthenticated",
        httpResponse.status === 403
          ? "The stored Claude token cannot read usage — sign in again with a recent `claude` CLI."
          : SIGN_IN_MESSAGE,
      );
    }
    if (httpResponse.status < 200 || httpResponse.status >= 300) {
      return failed("error", `Claude usage endpoint returned HTTP ${httpResponse.status}.`);
    }
    const payload = yield* httpResponse.json.pipe(Effect.result);
    if (Result.isFailure(payload)) {
      return failed("error", "Claude usage endpoint returned an unreadable response.");
    }

    const { windows, credits } = mapClaudeUsageResponse(payload.success);
    return {
      ...base,
      status: "ok",
      ...(planLabel ? { planLabel } : {}),
      windows,
      ...(credits ? { credits } : {}),
    } satisfies ProviderUsageSnapshot;
  }).pipe(
    Effect.catchDefect((defect: unknown) =>
      Effect.map(DateTime.now, (now) => ({
        instanceId: meta.instanceId,
        driver: meta.driverKind,
        ...(meta.displayName ? { displayName: meta.displayName } : {}),
        status: "error" as const,
        windows: [],
        message: `Claude usage fetch crashed: ${String(defect)}`,
        fetchedAt: DateTime.formatIso(now),
      })),
    ),
  );

  return { fetchUsage } satisfies ProviderUsageShape;
});
