/**
 * Tempo capacity integration (spec docs/t3work-mvp/29-planning-space.md §10.2).
 *
 * Capacity formula (v1):
 *   capacity(person, range) =
 *     Σ requiredSeconds(user-schedule, from..to)
 *     − Σ plannedSeconds(unavailability plans overlapping the range)
 *
 * Unavailability plans are non-issue plans plus plans on issues OUTSIDE the
 * project being planned (orgs commonly model off-project time as plans on
 * internal tracking issues, e.g. INT-2 "Nicht für Sprint/Projekt verfügbar").
 * Plans on the planned project's own issues are sprint work and never
 * subtracted — they would double-count against the assigned load.
 *
 * `user-schedule` is Tempo's resolved product — workload schemes, part-time
 * hours and holiday schemes are already applied per day, so no extra scheme
 * lookups are needed (those 403 with member tokens anyway).
 *
 * Token: `T3WORK_TEMPO_API_TOKEN` env var, else a persisted secret alongside
 * the Atlassian credentials (set via the /api/t3work/tempo/token route);
 * see t3work-tempoTokenStore.ts.
 */

import * as Effect from "effect/Effect";

import { providerForAccount } from "./t3work-atlassian-auth-store.ts";
import { toAtlassianError, tryAtlassianPromise } from "./t3work-atlassian-http.ts";
import {
  computeTempoUserCapacity,
  selectUnavailabilityPlans,
  type T3workTempoUserCapacity,
  type TempoPlan,
  type TempoScheduleDay,
} from "./t3work-tempoCapacityMath.ts";
import { loadTempoToken } from "./t3work-tempoTokenStore.ts";

export {
  computeTempoUserCapacity,
  planSecondsInRange,
  selectUnavailabilityPlans,
  type T3workTempoUserCapacity,
} from "./t3work-tempoCapacityMath.ts";
export { loadTempoToken, saveTempoToken } from "./t3work-tempoTokenStore.ts";

const TEMPO_BASE_URL = "https://api.tempo.io/4";
const TEMPO_PAGE_LIMIT = 200;
/** Runaway-pagination guard; a sprint window never needs more pages. */
const TEMPO_MAX_PAGES = 20;

export type T3workTempoCapacityInput = {
  readonly accountIds: ReadonlyArray<string>;
  /** Inclusive, YYYY-MM-DD (sprint start date). */
  readonly from: string;
  /** Inclusive, YYYY-MM-DD (sprint end date). */
  readonly to: string;
  /**
   * Jira project key being planned (e.g. "IES"). When set (with
   * `atlassianAccountId` for issue lookups), issue plans on OTHER projects
   * count as unavailability; without it only non-issue plans subtract.
   */
  readonly projectKey?: string;
  /** Atlassian account used to resolve plan issue ids to project keys. */
  readonly atlassianAccountId?: string;
};

export type T3workTempoCapacityResult = {
  readonly configured: boolean;
  readonly from: string;
  readonly to: string;
  readonly capacities: ReadonlyArray<T3workTempoUserCapacity>;
};

type TempoPage<T> = {
  readonly results?: ReadonlyArray<T>;
  readonly metadata?: { readonly next?: string };
};

// --- Tempo HTTP --------------------------------------------------------------

async function tempoGetAllPages<T>(token: string, firstUrl: string): Promise<T[]> {
  const collected: T[] = [];
  let url: string | undefined = firstUrl;
  for (let page = 0; url && page < TEMPO_MAX_PAGES; page++) {
    // @effect-diagnostics-next-line globalFetch:off
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(
        `Tempo request failed (${response.status}) for ${new URL(url).pathname}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await response.json()) as TempoPage<T>;
    collected.push(...(data.results ?? []));
    url = data.metadata?.next;
  }
  return collected;
}

function fetchUserSchedule(token: string, accountId: string, from: string, to: string) {
  const url = `${TEMPO_BASE_URL}/user-schedule/${encodeURIComponent(accountId)}?from=${from}&to=${to}&limit=${TEMPO_PAGE_LIMIT}`;
  return tempoGetAllPages<TempoScheduleDay>(token, url);
}

function fetchUserPlans(token: string, accountId: string, from: string, to: string) {
  const url = `${TEMPO_BASE_URL}/plans/user/${encodeURIComponent(accountId)}?from=${from}&to=${to}&limit=${TEMPO_PAGE_LIMIT}`;
  return tempoGetAllPages<TempoPlan>(token, url);
}

// --- route entry point --------------------------------------------------------

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Issue project keys never change — memoize across requests. */
const issueKeyCache = new Map<string, string | null>();

function makeIssueKeyResolver(atlassianAccountId: string) {
  return Effect.gen(function* () {
    const provider = yield* providerForAccount(atlassianAccountId);
    return async (issueId: string): Promise<string | null> => {
      const cached = issueKeyCache.get(issueId);
      if (cached !== undefined) return cached;
      const key = await Promise.resolve(
        "getBacklogIssue" in provider
          ? provider
              .getBacklogIssue({ accountId: atlassianAccountId, issueIdOrKey: issueId })
              .then((item) => item?.id ?? null)
              .catch(() => null)
          : null,
      );
      issueKeyCache.set(issueId, key);
      return key;
    };
  });
}

export function loadT3workTempoCapacity(input: T3workTempoCapacityInput) {
  return Effect.gen(function* () {
    if (!DATE_PATTERN.test(input.from) || !DATE_PATTERN.test(input.to)) {
      return yield* Effect.fail(
        toAtlassianError("Tempo capacity needs from/to as YYYY-MM-DD.")(null),
      );
    }
    const token = yield* loadTempoToken;
    if (!token) {
      return {
        configured: false,
        from: input.from,
        to: input.to,
        capacities: [],
      } satisfies T3workTempoCapacityResult;
    }
    const accountIds = [...new Set(input.accountIds)].slice(0, 100);
    const resolveIssueKey = input.atlassianAccountId
      ? yield* makeIssueKeyResolver(input.atlassianAccountId)
      : null;
    const capacities = yield* Effect.all(
      accountIds.map((accountId) =>
        tryAtlassianPromise(async () => {
          const [scheduleDays, plans] = await Promise.all([
            fetchUserSchedule(token, accountId, input.from, input.to),
            fetchUserPlans(token, accountId, input.from, input.to).catch(() => [] as TempoPlan[]),
          ]);
          const issueKeyById = new Map<string, string | null>();
          if (resolveIssueKey && input.projectKey) {
            const issueIds = [
              ...new Set(
                plans
                  .filter((plan) => (plan.planItem?.type ?? "").toUpperCase() === "ISSUE")
                  .map((plan) => plan.planItem?.id)
                  .filter((id): id is string => Boolean(id)),
              ),
            ];
            for (const issueId of issueIds) {
              issueKeyById.set(issueId, await resolveIssueKey(issueId));
            }
          }
          return computeTempoUserCapacity({
            accountId,
            scheduleDays,
            unavailabilityPlans: selectUnavailabilityPlans(plans, {
              projectKey: input.projectKey,
              issueKeyById,
            }),
            from: input.from,
            to: input.to,
          });
        }, `Tempo capacity lookup failed for ${accountId}.`).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              accountId,
              requiredSeconds: 0,
              plannedSeconds: 0,
              capacitySeconds: 0,
              workingDays: 0,
              error: error.message,
            } satisfies T3workTempoUserCapacity),
          ),
        ),
      ),
      { concurrency: 5 },
    );
    return {
      configured: true,
      from: input.from,
      to: input.to,
      capacities,
    } satisfies T3workTempoCapacityResult;
  });
}
