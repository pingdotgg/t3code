/**
 * Issue status automation: rules map a tracker container's statuses (a Linear team's workflow) to
 * wake, snooze, or settle. A sweep reads the status of every issue linked to an active thread and
 * acts only on a change since the last read, so the first read and any manual organizing stand.
 */
import {
  CommandId,
  IssueAutomationError,
  type IssueAutomationCatalog,
  type IssueAutomationCatalogInput,
  type IssueAutomationOverview,
  type IssueAutomationRule,
  type IssueAutomationSaveInput,
  type IssueTrackerKind,
  type ThreadIssueLink,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  isStandaloneIssueTracker,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SecureRandom from "effect/crypto/SecureRandom";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Observations from "../persistence/IssueThreadAutomation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";
import {
  aggregateIssueActions,
  automationFingerprint,
  changedIssueStatuses,
  ISSUE_AUTOMATION_STALE,
} from "./issueAutomation.ts";

export class IssueThreadAutomationService extends Context.Service<
  IssueThreadAutomationService,
  {
    readonly overview: Effect.Effect<IssueAutomationOverview, IssueAutomationError>;
    readonly catalog: (
      input: IssueAutomationCatalogInput,
    ) => Effect.Effect<IssueAutomationCatalog, IssueAutomationError>;
    readonly save: (
      input: IssueAutomationSaveInput,
    ) => Effect.Effect<IssueAutomationOverview, IssueAutomationError>;
    /** Reads every linked issue's status once and organizes the threads whose issues moved. */
    readonly sweep: Effect.Effect<void, IssueAutomationError>;
    /** Rises each time a sweep sees the issue's status change; 0 until it does. */
    readonly subscribeStatusRefreshes: (input: {
      readonly tracker: IssueTrackerKind;
      readonly key: string;
    }) => Stream.Stream<number>;
  }
>()("t3/issue/IssueThreadAutomationService") {}

type RuntimeStatus = IssueAutomationOverview["status"][number];

const RETRY_AFTER_MS = 60_000;
const isIssueTrackerError = Schema.is(IssueTrackerError);
const isIssueAutomationError = Schema.is(IssueAutomationError);
const wrap = (operation: string) => (cause: unknown) =>
  isIssueAutomationError(cause)
    ? cause
    : new IssueAutomationError({
        operation,
        ...(isIssueTrackerError(cause) && cause.detail.trim() ? { detail: cause.detail } : {}),
        cause,
      });
const observationKey = (rule: IssueAutomationRule, link: ThreadIssueLink) =>
  `${rule.id}\0${link.key.toUpperCase()}`;
const refreshKey = (tracker: string, key: string) => `${tracker}\0${key.toUpperCase()}`;
const sameWorkspace = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const observations = yield* Observations.IssueThreadAutomation;
  const random = yield* SecureRandom.SecureRandom;
  // Saves, and the dispatch that checks the rules a decision saw, never interleave.
  const saveLock = yield* Semaphore.make(1);
  const refreshes = yield* SubscriptionRef.make<ReadonlyMap<string, number>>(new Map());
  let refreshRevision = 0;
  const runtime = new Map<string, RuntimeStatus>();
  const retryAt = new Map<string, number>();
  const newCommandId = random.uuidV4().pipe(
    Effect.orDie,
    Effect.map((id) => CommandId.make(`server:issue-automation:${id}`)),
  );

  const automationOf = (tracker: IssueTrackerKind) => {
    const api = registry.get(tracker);
    return api !== null && isStandaloneIssueTracker(api) && api.automation !== undefined
      ? { api, automation: api.automation }
      : null;
  };
  /** A link belongs to a rule when it names an issue in the rule's tracker workspace. */
  const matches = (rule: IssueAutomationRule, link: ThreadIssueLink) => {
    if (rule.tracker !== link.tracker) return false;
    const api = registry.get(link.tracker);
    if (api === null || !isStandaloneIssueTracker(api) || !URL.canParse(link.url)) return false;
    const parsed = api.parseIssueUrl(new URL(link.url));
    return parsed !== null && sameWorkspace(parsed.workspace, rule.workspace);
  };

  const overview = settings.getSettings.pipe(
    Effect.map((config) => ({
      rules: config.issueThreadAutomationRules,
      status: config.issueThreadAutomationRules.map(
        (rule) => runtime.get(rule.id) ?? { ruleId: rule.id, checkedAt: null, error: null },
      ),
    })),
    Effect.mapError(wrap("overview")),
  );

  const catalog = Effect.fn("IssueThreadAutomationService.catalog")(
    function* (input: IssueAutomationCatalogInput) {
      const found = automationOf(input.tracker);
      if (found === null)
        return yield* new IssueAutomationError({
          operation: "catalog",
          detail: "This tracker has no status rules.",
        });
      const listed = yield* found.automation.listContainers();
      if (input.containerId === undefined) return { ...listed, states: [] };
      if (!listed.containers.some((container) => container.id === input.containerId))
        return yield* new IssueAutomationError({
          operation: "catalog",
          detail: "The connected account cannot reach this team or board.",
        });
      const states = yield* found.automation.listStates({
        workspace: listed.workspace,
        containerId: input.containerId,
      });
      return { ...listed, states };
    },
    Effect.mapError(wrap("catalog")),
  );

  const save = Effect.fn("IssueThreadAutomationService.save")(
    function* (input: IssueAutomationSaveInput) {
      const rule = input.rule;
      let disableStored = false;
      if (rule !== null) {
        if (rule.id !== input.id)
          return yield* new IssueAutomationError({
            operation: "save",
            detail: "The rule does not match the id it is saved under.",
          });
        const requested = rule;
        const existing = (yield* settings.getSettings).issueThreadAutomationRules.find(
          (candidate) => candidate.id === requested.id,
        );
        const read = yield* catalog({
          tracker: requested.tracker,
          containerId: requested.containerId,
        }).pipe(Effect.result);
        const reachable =
          read._tag === "Success" &&
          sameWorkspace(read.success.workspace, requested.workspace) &&
          (existing === undefined || sameWorkspace(existing.workspace, requested.workspace));
        if (!reachable) {
          // A rule the current connection cannot reach can still be switched off.
          if (requested.enabled || existing === undefined)
            return yield* read._tag === "Failure"
              ? read.failure
              : new IssueAutomationError({
                  operation: "save",
                  detail: "The connected account is in another workspace.",
                });
          disableStored = true;
        }
      }
      const generation = yield* newCommandId;
      return yield* saveLock.withPermit(
        Effect.gen(function* () {
          const stored = (yield* settings.getSettings).issueThreadAutomationRules;
          const rules = stored.filter((candidate) => candidate.id !== input.id);
          // Switching off disables the rule as stored now; one removed meanwhile stays removed.
          const base = disableStored ? stored.find((candidate) => candidate.id === input.id) : rule;
          if (base === undefined) return yield* overview;
          const saved =
            base === null
              ? null
              : { ...base, ...(disableStored ? { enabled: false } : {}), generation };
          if (saved !== null) {
            if (
              rules.some(
                (candidate) =>
                  candidate.tracker === saved.tracker &&
                  sameWorkspace(candidate.workspace, saved.workspace) &&
                  candidate.containerId === saved.containerId,
              )
            )
              return yield* new IssueAutomationError({
                operation: "save",
                detail: "This team or board already has a rule.",
              });
            rules.push(saved);
          }
          yield* settings.updateSettings({ issueThreadAutomationRules: rules });
          return yield* overview;
        }),
      );
    },
    Effect.mapError(wrap("save")),
  );

  /** One read per rule: each issue's status id by key, or null when the read failed. */
  const readStatuses = Effect.fn("IssueThreadAutomationService.readStatuses")(function* (
    rule: IssueAutomationRule,
    keys: ReadonlyArray<string>,
    now: number,
  ) {
    const found = automationOf(rule.tracker);
    const read =
      found === null
        ? Effect.fail(
            new IssueTrackerError({
              tracker: rule.tracker,
              operation: "automation",
              reason: "missing-tool",
              detail: "This tracker has no status rules.",
            }),
          )
        : found.automation.readStatuses({
            workspace: rule.workspace,
            containerId: rule.containerId,
            keys,
          });
    const statuses = yield* read.pipe(
      Effect.timeout("45 seconds"),
      Effect.map((rows) => new Map(rows.map((row) => [row.key.toUpperCase(), row.stateId]))),
      Effect.catch((error) =>
        Effect.sync(() => {
          runtime.set(rule.id, {
            ruleId: rule.id,
            checkedAt: runtime.get(rule.id)?.checkedAt ?? null,
            error: isIssueTrackerError(error) ? error.reason : "failed",
          });
          retryAt.set(
            rule.id,
            isIssueTrackerError(error) && error.retryAt !== undefined
              ? error.retryAt
              : now + RETRY_AFTER_MS,
          );
          return null;
        }),
      ),
    );
    if (statuses !== null) {
      retryAt.delete(rule.id);
      runtime.set(rule.id, {
        ruleId: rule.id,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        error: null,
      });
    }
    return statuses;
  });

  const sweep = Effect.gen(function* () {
    const config = yield* settings.getSettings;
    const rules = config.issueThreadAutomationRules.filter((rule) => rule.enabled);
    if (rules.length === 0) {
      yield* observations.prune([]);
      return;
    }
    const rulesFingerprint = automationFingerprint(config.issueThreadAutomationRules);
    const candidates = (yield* projections.getIssueAutomationCandidates()).flatMap(
      ({ thread, revision }) => {
        // Rules leave a thread with auto-settle off alone; pruning drops any action it waited on.
        if (thread.autoSettleDisabledAt != null) return [];
        const links = rules.flatMap((rule) =>
          (thread.issues ?? [])
            .filter((link) => matches(rule, link))
            .map((link) => ({ rule, link, key: observationKey(rule, link) })),
        );
        return links.length === 0 ? [] : [{ thread, revision, links }];
      },
    );
    const previous = yield* observations.list;
    const now = yield* Clock.currentTimeMillis;
    // Null for a rule whose statuses could not be read this sweep.
    const batches = new Map<string, ReadonlyMap<string, string> | null>();
    for (const rule of rules) {
      const keys = [
        ...new Set(
          candidates.flatMap(({ links }) =>
            links.filter((entry) => entry.rule === rule).map(({ link }) => link.key),
          ),
        ),
      ];
      if (keys.length === 0) continue;
      batches.set(
        rule.id,
        (retryAt.get(rule.id) ?? 0) > now ? null : yield* readStatuses(rule, keys, now),
      );
    }
    const refreshed = new Set<string>();
    for (const { thread, revision, links } of candidates) {
      const batchOf = (rule: IssueAutomationRule) => batches.get(rule.id) ?? null;
      const old = previous.get(thread.id);
      // A link the read left out is outside the rule's container, unless it was seen there before.
      const eligible = links.filter(
        ({ rule, link, key }) =>
          batchOf(rule) === null ||
          batchOf(rule)?.has(link.key.toUpperCase()) === true ||
          old?.statuses[key] != null,
      );
      const fingerprint = automationFingerprint({
        rules: [...new Set(links.map(({ rule }) => rule))],
        links: links.map(({ key, link }) => [key, link.url, link.linkedAt]).sort(),
      });
      const baseline = old?.fingerprint === fingerprint ? old : undefined;
      const statuses = Object.fromEntries(
        eligible.map(({ rule, link, key }) => [
          key,
          batchOf(rule)?.get(link.key.toUpperCase()) ?? baseline?.statuses[key] ?? null,
        ]),
      );
      const changed = changedIssueStatuses(baseline?.statuses ?? null, statuses);
      if (changed) {
        // An open issue detail reads the status again, whether or not a rule maps it.
        for (const { rule, link, key } of eligible) {
          const id = refreshKey(rule.tracker, link.key);
          const before = baseline?.statuses[key];
          if (refreshed.has(id) || before == null || statuses[key] == null) continue;
          if (before === statuses[key]) continue;
          refreshed.add(id);
          refreshRevision += 1;
          const next = refreshRevision;
          yield* SubscriptionRef.update(refreshes, (current) => new Map(current).set(id, next));
        }
      }
      const actions = eligible.map(({ rule, link }) => {
        const stateId = batchOf(rule)?.get(link.key.toUpperCase());
        return stateId === undefined ? null : (rule.mappings[stateId] ?? "unchanged");
      });
      const action = aggregateIssueActions(actions);
      const unknown = actions.includes(null);
      let pending = baseline?.pending ?? null;
      if (changed) {
        pending =
          action === "unchanged" && !unknown
            ? null
            : { commandId: yield* newCommandId, action, revision };
      } else if (pending?.action === "unchanged" && !unknown) {
        // A change waited for an unread issue, which has now been read.
        pending = action === "unchanged" ? null : { ...pending, action };
      }
      // A waiting action keeps the revision it was decided at; organizing the thread cancels it.
      if (pending !== null && pending.revision !== revision) pending = null;
      const observation: Observations.Observation = {
        threadId: thread.id,
        fingerprint,
        statuses,
        pending,
      };
      if (old === undefined || automationFingerprint(old) !== automationFingerprint(observation))
        yield* observations.save(observation);
      if (pending === null || pending.action === "unchanged" || pending.action !== action) continue;
      const command = {
        type: "thread.issue-automation.apply" as const,
        commandId: pending.commandId,
        threadId: thread.id,
        action: pending.action,
        expectedRevision: pending.revision,
        rulesFingerprint,
      };
      const waiting = yield* saveLock.withPermit(
        Effect.gen(function* () {
          const current = yield* settings.getSettings;
          if (automationFingerprint(current.issueThreadAutomationRules) !== rulesFingerprint)
            return false;
          return yield* orchestrator.dispatch(command).pipe(
            Effect.as(false),
            // Only a stale decision is dropped; a busy thread or a failed attempt tries again.
            Effect.catch((error) =>
              Effect.succeed(
                !(
                  error._tag === "OrchestratorDispatchError" &&
                  error.cause === ISSUE_AUTOMATION_STALE
                ),
              ),
            ),
          );
        }),
      );
      // A refused command id is spent, so the next attempt needs a new one.
      yield* observations.save({
        ...observation,
        pending: waiting ? { ...pending, commandId: yield* newCommandId } : null,
      });
    }
    yield* observations.prune(candidates.map(({ thread }) => thread.id));
    const linked = new Set(
      candidates.flatMap(({ links }) =>
        links.map(({ link }) => refreshKey(link.tracker, link.key)),
      ),
    );
    yield* SubscriptionRef.update(
      refreshes,
      (current) => new Map([...current].filter(([key]) => linked.has(key))),
    );
  }).pipe(Effect.mapError(wrap("sweep")));

  return IssueThreadAutomationService.of({
    overview,
    catalog,
    save,
    sweep,
    subscribeStatusRefreshes: ({ tracker, key }) =>
      SubscriptionRef.changes(refreshes).pipe(
        Stream.map((issues) => issues.get(refreshKey(tracker, key)) ?? 0),
        Stream.changes,
      ),
  });
});

export const layer = Layer.effect(IssueThreadAutomationService, make).pipe(
  Layer.provide(Observations.layer),
);
