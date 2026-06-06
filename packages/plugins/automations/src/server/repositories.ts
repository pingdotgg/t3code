import type {
  PluginActivationContext,
  PluginCollection,
  PluginStoreError,
} from "@t3tools/plugin-api/server";
import { PLUGIN_CATALOG_INVALIDATED_EVENT_TYPE } from "@t3tools/plugin-api/server";
import * as Effect from "effect/Effect";

import { AUTOMATIONS_EVENTS } from "../shared/constants.ts";
import { AutomationRule, AutomationRuleId, AutomationRun } from "../shared/schema.ts";
import { RULES_COLLECTION, RUNS_COLLECTION, RUN_RETENTION_PER_RULE } from "./constants.ts";
import { AutomationPluginError } from "./errors.ts";
import { compareNewestRuns } from "./runs.ts";

export interface AutomationCollections {
  readonly rules: PluginCollection<AutomationRule>;
  readonly runs: PluginCollection<AutomationRun>;
}

export const registerAutomationCollections = (
  ctx: PluginActivationContext,
): Effect.Effect<AutomationCollections, PluginStoreError> =>
  Effect.gen(function* () {
    const rules = yield* ctx.store.registerCollection(RULES_COLLECTION, AutomationRule);
    const runs = yield* ctx.store.registerCollection(RUNS_COLLECTION, AutomationRun);
    return { rules, runs };
  });

export function makeAutomationRepositories(
  ctx: PluginActivationContext,
  collections: AutomationCollections,
) {
  const listRules = (input: {
    readonly projectId?: AutomationRule["projectId"] | undefined;
    readonly enabled?: boolean | undefined;
  }) =>
    collections.rules.list().pipe(
      Effect.map((rules) =>
        [...rules]
          .filter((rule) => input.projectId === undefined || rule.projectId === input.projectId)
          .filter((rule) => input.enabled === undefined || rule.enabled === input.enabled)
          .sort((first, second) => first.name.localeCompare(second.name)),
      ),
    );

  const getRule = (ruleId: AutomationRuleId) => collections.rules.get(ruleId);

  const requireRule = (ruleId: AutomationRuleId) =>
    getRule(ruleId).pipe(
      Effect.flatMap((rule) =>
        rule === null
          ? Effect.fail(
              new AutomationPluginError({
                message: `Automation rule ${ruleId} was not found.`,
              }),
            )
          : Effect.succeed(rule),
      ),
    );

  const ruleExists = (ruleId: AutomationRuleId) =>
    getRule(ruleId).pipe(Effect.map((rule) => rule !== null));

  const listRuns = () => collections.runs.list();

  const listRunsForRule = (ruleId: AutomationRuleId) =>
    listRuns().pipe(
      Effect.map((runs) =>
        runs
          .filter((run) => run.ruleId === ruleId)
          .slice()
          .sort(compareNewestRuns),
      ),
    );

  const publishChanged = (payload: unknown) =>
    ctx.events.publish({
      type: AUTOMATIONS_EVENTS.changed,
      payload,
    });

  const publishCatalogInvalidated = (payload: unknown) =>
    ctx.events.publish({
      type: PLUGIN_CATALOG_INVALIDATED_EVENT_TYPE,
      payload,
    });

  const isFailedOrSkippedRun = (run: AutomationRun | null | undefined) =>
    run?.status === "failed" || run?.status === "skipped";

  const countFailedOrSkippedRuns = () =>
    listRuns().pipe(Effect.map((runs) => runs.filter((run) => isFailedOrSkippedRun(run)).length));

  const publishCatalogInvalidatedIfRunCountChanged = (
    payload: unknown,
    before: AutomationRun | null | undefined,
    after: AutomationRun | null | undefined,
  ) =>
    isFailedOrSkippedRun(before) === isFailedOrSkippedRun(after)
      ? Effect.void
      : publishCatalogInvalidated(payload);

  const publishCatalogInvalidatedIfRunSetChanged = (
    payload: unknown,
    beforeRuns: ReadonlyArray<AutomationRun | null | undefined>,
    afterRuns: ReadonlyArray<AutomationRun | null | undefined>,
  ) =>
    beforeRuns.filter(isFailedOrSkippedRun).length === afterRuns.filter(isFailedOrSkippedRun).length
      ? Effect.void
      : publishCatalogInvalidated(payload);

  const writeRule = (rule: AutomationRule) =>
    collections.rules
      .upsert(rule.id, rule)
      .pipe(Effect.andThen(publishChanged({ ruleId: rule.id })), Effect.as(rule));

  const writeRun = (run: AutomationRun, input?: { readonly publish?: boolean }) => {
    const publish = input?.publish ?? true;
    const payload = { runId: run.id, ruleId: run.ruleId };
    return Effect.gen(function* () {
      const previousRun = yield* collections.runs.get(run.id);
      yield* collections.runs.upsert(run.id, run);
      if (publish) {
        yield* publishChanged(payload);
        yield* publishCatalogInvalidatedIfRunCountChanged(payload, previousRun, run);
      }
      return { previousRun, run };
    });
  };

  const trimRunsForRule = (
    ruleId: AutomationRuleId,
    input?: {
      readonly publish?: boolean;
      readonly extraBeforeRuns?: ReadonlyArray<AutomationRun>;
    },
  ) =>
    Effect.gen(function* () {
      const publish = input?.publish ?? true;
      const staleRuns = (yield* listRunsForRule(ruleId)).slice(RUN_RETENTION_PER_RULE);
      if (staleRuns.length === 0) {
        return staleRuns;
      }
      yield* Effect.forEach(staleRuns, (run) => collections.runs.delete(run.id), {
        concurrency: 1,
        discard: true,
      });
      if (publish) {
        yield* publishChanged({ ruleId, trimmed: true });
        yield* publishCatalogInvalidatedIfRunSetChanged(
          { ruleId, trimmed: true },
          [...(input?.extraBeforeRuns ?? []), ...staleRuns],
          [],
        );
      }
      return staleRuns;
    });

  const writeRunAndTrimForRule = (run: AutomationRun, payload: unknown) =>
    Effect.gen(function* () {
      const written = yield* writeRun(run, { publish: false });
      const trimmedRuns = yield* trimRunsForRule(run.ruleId, { publish: false });
      yield* publishChanged(payload);
      yield* publishCatalogInvalidatedIfRunSetChanged(
        payload,
        [written.previousRun, ...trimmedRuns],
        [written.run],
      );
    });

  return {
    collections,
    listRules,
    getRule,
    requireRule,
    ruleExists,
    listRuns,
    listRunsForRule,
    publishChanged,
    publishCatalogInvalidated,
    isFailedOrSkippedRun,
    countFailedOrSkippedRuns,
    writeRule,
    writeRun,
    trimRunsForRule,
    writeRunAndTrimForRule,
  } as const;
}
