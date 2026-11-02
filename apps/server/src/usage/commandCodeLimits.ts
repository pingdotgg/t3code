// @effect-diagnostics nodeBuiltinImport:off -- standalone CLI auth file is read once per refresh.
// @effect-diagnostics globalDate:off -- upstream reset timestamps are epoch milliseconds or ISO.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// These endpoints are used by Command Code CLI 1.88.2, not part of a public
// stable API. Fail closed when they change; never manufacture quota percentages.
const ORIGIN = "https://api.commandcode.ai";
const CLIENT_USER_AGENT = "command-code/1.88.2";
const SOURCE_ID = UsageLimitSourceId.make("command-code-local");
const DRIVER = ProviderDriverKind.make("command-code");
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function resetTimestamp(value: unknown): string | undefined {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? value < 1e11
        ? value * 1_000
        : value
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const timestamp = new Date(parsed);
  return Number.isNaN(timestamp.getTime()) ? undefined : timestamp.toISOString();
}

export function commandCodeMonthlyWindow(
  creditsPayload: unknown,
  subscriptionPayload: unknown,
): ServerProviderUsageWindow | null {
  const credits = object(object(creditsPayload)?.credits);
  const subscription = object(object(subscriptionPayload)?.data);
  const remaining = validNumber(credits?.monthlyCredits);
  // Published model-dependent "usage value" figures are not a guaranteed
  // denominator for the remaining monthly credit balance. Use only the
  // explicit credit allowance, if the CLI API returns one.
  const allowance = validNumber(credits?.monthlyCreditsTotal);
  const resetsAt = resetTimestamp(subscription?.currentPeriodEnd);
  if (
    subscription?.status !== "active" ||
    allowance === null ||
    allowance <= 0 ||
    remaining === null ||
    remaining < 0 ||
    remaining > allowance ||
    !resetsAt
  )
    return null;
  return {
    id: "command_monthly",
    kind: "monthly",
    label: "Monthly plan credits",
    usedPercent: ((allowance - remaining) / allowance) * 100,
    resetsAt,
  };
}

/** Command Code exposes used and cap in credits; never infer from token spend. */
export function commandCodeWindows(payload: unknown): ServerProviderUsageWindow[] {
  const limits = object(object(payload)?.windowLimits);
  if (!limits) return [];
  const descriptions = [
    { key: "fiveHour", id: "command_five_hour", label: "5 hours", kind: "session", minutes: 300 },
    { key: "weekly", id: "command_weekly", label: "Weekly", kind: "weekly", minutes: 10080 },
  ] as const;
  return descriptions.flatMap(({ key, id, label, kind, minutes }) => {
    const value = object(limits[key]);
    if (!value) return [];
    const used = validNumber(value.used);
    const cap = validNumber(value.cap);
    if (used === null || cap === null || used < 0 || cap <= 0) return [];
    const resetsAt = resetTimestamp(value.resetAt);
    return [
      {
        id,
        label,
        kind,
        usedPercent: Math.min(100, Math.max(0, (used / cap) * 100)),
        windowDurationMins: minutes,
        ...(resetsAt ? { resetsAt } : {}),
      },
    ];
  });
}

function credential(content: string): string | null {
  try {
    const auth = object(JSON.parse(content));
    const key = auth?.apiKey;
    return typeof key === "string" && key.trim().length > 0 ? key.trim() : null;
  } catch {
    return null;
  }
}

export const readCommandCodeLimitSource = Effect.fn("readCommandCodeLimitSource")(
  function* (options?: { readonly authPath?: string }) {
    const content = yield* Effect.tryPromise(() =>
      NodeFSP.readFile(
        options?.authPath ?? NodePath.join(NodeOS.homedir(), ".commandcode", "auth.json"),
        "utf8",
      ),
    ).pipe(Effect.orElseSucceed(() => null));
    // When not signed in, Command Code is an unavailable local limits source.
    if (content === null) return null;

    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const base = {
      id: SOURCE_ID,
      // Compatibility envelope: older T3 Connect clients decode source.kind as
      // the single literal "cliproxy". Its account.driver remains "command-code"
      // and the actual endpoint is still the Command Code API, never a cliproxy.
      kind: "cliproxy" as const,
      label: "Command Code",
      checkedAt,
    };
    const apiKey = credential(content);
    if (!apiKey)
      return { ...base, accounts: [], error: "Command Code credentials are unavailable." };

    const client = yield* HttpClient.HttpClient;
    const get = (url: string) =>
      client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeader("user-agent", CLIENT_USER_AGENT),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((response) => response.json),
          Effect.timeout("8 seconds"),
        );
    const response = yield* Effect.gen(function* () {
      const whoami = object(yield* get(ORIGIN + "/alpha/whoami?limits=1"));
      if (!whoami || whoami.success === false) return null;
      const organization = object(whoami.org);
      const organizationId = organization?.id;
      const query =
        typeof organizationId === "string" && organizationId.length > 0
          ? "?orgId=" + encodeURIComponent(organizationId)
          : "";
      // Both endpoints depend only on whoami; fetch them together so a slow
      // optional subscription lookup cannot serialize the quota refresh.
      const [credits, subscription] = yield* Effect.all(
        [
          get(ORIGIN + "/alpha/billing/credits" + query),
          get(ORIGIN + "/alpha/billing/subscriptions" + query).pipe(
            Effect.orElseSucceed(() => null),
          ),
        ],
        { concurrency: 2 },
      );
      return { credits, subscription };
    }).pipe(
      Effect.timeout("12 seconds"),
      Effect.orElseSucceed(() => null),
    );

    if (response === null)
      return { ...base, accounts: [], error: "Command Code quota API is unavailable." };
    const windows = commandCodeWindows(response.credits);
    const monthly = commandCodeMonthlyWindow(response.credits, response.subscription);
    if (monthly) windows.push(monthly);
    if (
      windows.length === 0 &&
      object(response.credits)?.windowLimits &&
      object(object(response.credits)?.windowLimits)?.limited === false
    )
      return null;
    if (windows.length === 0)
      return { ...base, accounts: [], error: "Command Code did not report rolling quota windows." };
    return {
      ...base,
      accounts: [
        {
          id: "Command Code",
          driver: DRIVER,
          usageLimits: { checkedAt, windows },
        },
      ],
    } satisfies UsageLimitSourceSnapshot;
  },
);
