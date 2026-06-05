import { PluginCommandName } from "@t3tools/plugin-api/schema";
import type { PluginActivationContext } from "@t3tools/plugin-api/server";
import * as Effect from "effect/Effect";

import { AUTOMATIONS_COMMANDS, type AutomationCommandName } from "../shared/constants.ts";
import {
  AutomationsRulesCreateInput,
  AutomationsRulesCreateResult,
  AutomationsRulesDeleteInput,
  AutomationsRulesDeleteResult,
  AutomationsRulesListInput,
  AutomationsRulesListResult,
  AutomationsRulesRunNowInput,
  AutomationsRulesRunNowResult,
  AutomationsRulesUpdateInput,
  AutomationsRulesUpdateResult,
  AutomationsRunsListRecentInput,
  AutomationsRunsListRecentResult,
  type AutomationRule,
} from "../shared/schema.ts";
import { AutomationPluginError } from "./errors.ts";
import { nextRuleId } from "./ids.ts";
import { compareNewestRuns } from "./runs.ts";
import type { AutomationCollections, AutomationsRuntime } from "./runtime.ts";
import { nowIso } from "./time.ts";

export function commandName(name: AutomationCommandName) {
  return PluginCommandName.make(name);
}

export const registerAutomationCommands = (
  ctx: PluginActivationContext,
  runtime: AutomationsRuntime,
  collections: AutomationCollections,
) =>
  Effect.gen(function* () {
    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesList), {
      input: AutomationsRulesListInput,
      output: AutomationsRulesListResult,
      handler: (input) => runtime.listRules(input).pipe(Effect.map((rules) => ({ rules }))),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesCreate), {
      input: AutomationsRulesCreateInput,
      output: AutomationsRulesCreateResult,
      handler: (input) =>
        Effect.gen(function* () {
          const createdAt = yield* nowIso;
          const rule: AutomationRule = {
            id: nextRuleId(),
            name: input.name,
            enabled: input.enabled ?? true,
            projectId: input.projectId,
            cron: input.cron,
            timezone: input.timezone,
            prompt: input.prompt,
            createdAt,
            updatedAt: createdAt,
          };
          yield* runtime.persistRuleSchedule(rule);
          yield* collections.rules
            .upsert(rule.id, rule)
            .pipe(
              Effect.catch((error) =>
                collections.scheduleState
                  .delete(rule.id)
                  .pipe(Effect.ignoreCause({ log: true }), Effect.andThen(Effect.fail(error))),
              ),
            );
          yield* runtime.publishChanged({ ruleId: rule.id });
          return { rule };
        }),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesUpdate), {
      input: AutomationsRulesUpdateInput,
      output: AutomationsRulesUpdateResult,
      handler: (input) =>
        Effect.gen(function* () {
          const existing = yield* collections.rules.get(input.ruleId);
          if (existing === null) {
            return yield* new AutomationPluginError({
              message: `Automation rule ${input.ruleId} was not found.`,
            });
          }
          const updatedAt = yield* nowIso;
          const patch = input.patch;
          const rule: AutomationRule = {
            ...existing,
            name: patch.name ?? existing.name,
            enabled: patch.enabled ?? existing.enabled,
            projectId: patch.projectId ?? existing.projectId,
            cron: patch.cron ?? existing.cron,
            timezone: patch.timezone ?? existing.timezone,
            prompt: patch.prompt ?? existing.prompt,
            updatedAt,
          };
          yield* runtime.persistRuleSchedule(rule);
          yield* collections.rules
            .upsert(rule.id, rule)
            .pipe(
              Effect.catch((error) =>
                runtime
                  .persistRuleSchedule(existing)
                  .pipe(Effect.ignoreCause({ log: true }), Effect.andThen(Effect.fail(error))),
              ),
            );
          yield* runtime.publishChanged({ ruleId: rule.id });
          return { rule };
        }),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesDelete), {
      input: AutomationsRulesDeleteInput,
      output: AutomationsRulesDeleteResult,
      handler: (input) => runtime.deleteRule(input.ruleId).pipe(Effect.as({})),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesRunNow), {
      input: AutomationsRulesRunNowInput,
      output: AutomationsRulesRunNowResult,
      handler: (input) =>
        Effect.gen(function* () {
          const scheduledFor = yield* nowIso;
          const run = yield* runtime.executeRule(input.ruleId, "manual", scheduledFor);
          return { run };
        }),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.runsListRecent), {
      input: AutomationsRunsListRecentInput,
      output: AutomationsRunsListRecentResult,
      handler: (input) =>
        Effect.gen(function* () {
          const limit = Math.min(input.limit ?? 100, 500);
          const runs =
            input.ruleId === undefined
              ? [...(yield* runtime.listRuns())].sort(compareNewestRuns)
              : yield* runtime.listRunsForRule(input.ruleId);
          return { runs: runs.slice(0, limit) };
        }),
    });
  });
