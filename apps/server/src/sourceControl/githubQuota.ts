import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

/** The share of each quota a background read leaves for a user's next click. */
const RESERVE_RATIO = 0.1;

/**
 * GitHub's quotas: `core` for REST, `graphql` for GraphQL, and a few smaller ones (`search`, …).
 * Each is spent and reset on its own, so each is tracked on its own.
 */
type GitHubQuotaResource = string;

interface QuotaSnapshot {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAtMs: number;
}

/**
 * What GitHub says is left of one quota, from the `x-ratelimit-*` headers every API answer
 * carries. Null when the answer named no quota, which an Enterprise host with limits off does.
 */
function quotaFromHeaders(
  headers: Readonly<Record<string, string | undefined>>,
): (QuotaSnapshot & { readonly resource: GitHubQuotaResource }) | null {
  const resource = headers["x-ratelimit-resource"]?.trim();
  const limit = Number(headers["x-ratelimit-limit"]);
  const remaining = Number(headers["x-ratelimit-remaining"]);
  const reset = Number(headers["x-ratelimit-reset"]);
  if (
    !resource ||
    !Number.isFinite(limit) ||
    limit <= 0 ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    !Number.isFinite(reset)
  ) {
    return null;
  }
  return { resource, limit, remaining, resetAtMs: reset * 1_000 };
}

/**
 * Keeps the last tenth of each GitHub quota for interactive requests. A background sweep that
 * would dip below it is refused until the quota resets, so a user's next click still has budget.
 *
 * The balance comes from the response headers. Requests in flight together would all see the
 * last answer's balance, so each one admitted counts a point against it until its own answer
 * replaces the guess. A GraphQL read can cost more than a point; the reserve absorbs the difference.
 */
export class GitHubQuota extends Context.Service<
  GitHubQuota,
  {
    readonly admit: (
      host: string,
      resource: GitHubQuotaResource,
      options?: { readonly allowReserve: boolean },
    ) => Effect.Effect<void, SourceControlRateLimit.SourceControlRateLimitPausedError>;
    readonly observe: (
      host: string,
      headers: Readonly<Record<string, string | undefined>>,
    ) => Effect.Effect<void>;
  }
>()("t3/sourceControl/githubQuota") {}

const make = Effect.gen(function* () {
  const snapshots = yield* Ref.make<ReadonlyMap<string, QuotaSnapshot>>(new Map());
  const keyOf = (host: string, resource: string, scope: string) =>
    `${host.trim().toLowerCase()}\0${resource}\0${scope}`;

  const admit: GitHubQuota["Service"]["admit"] = Effect.fn("GitHubQuota.admit")(
    function* (host, resource, options) {
      const now = yield* Clock.currentTimeMillis;
      const key = keyOf(host, resource, yield* SourceControlRateLimit.CredentialScope);
      const retryAt = yield* Ref.modify(snapshots, (current) => {
        const snapshot = current.get(key);
        if (snapshot === undefined || snapshot.resetAtMs <= now) return [null, current] as const;
        const remaining = snapshot.remaining - 1;
        if (options?.allowReserve !== true && remaining < snapshot.limit * RESERVE_RATIO) {
          return [snapshot.resetAtMs, current] as const;
        }
        const next = new Map(current);
        next.set(key, { ...snapshot, remaining });
        return [null, next] as const;
      });
      if (retryAt === null) return;
      return yield* new SourceControlRateLimit.SourceControlRateLimitPausedError({
        provider: "github",
        host: host.trim().toLowerCase(),
        retryAt,
      });
    },
  );

  const observe: GitHubQuota["Service"]["observe"] = Effect.fn("GitHubQuota.observe")(
    function* (host, headers) {
      const quota = quotaFromHeaders(headers);
      if (quota === null) return;
      const key = keyOf(host, quota.resource, yield* SourceControlRateLimit.CredentialScope);
      yield* Ref.update(snapshots, (current) => {
        const previous = current.get(key);
        // Within one window the quota only falls, so the lower balance wins: an answer that
        // finished out of order, or one that predates requests admitted since, says too much is
        // left. An answer from an older window must not replace the current one.
        if (
          previous !== undefined &&
          (quota.resetAtMs < previous.resetAtMs ||
            (quota.resetAtMs === previous.resetAtMs && quota.remaining > previous.remaining))
        ) {
          return current;
        }
        const next = new Map(current);
        next.set(key, {
          limit: quota.limit,
          remaining: quota.remaining,
          resetAtMs: quota.resetAtMs,
        });
        return next;
      });
    },
  );

  return GitHubQuota.of({ admit, observe });
});

export const layer = Layer.effect(GitHubQuota, make);
