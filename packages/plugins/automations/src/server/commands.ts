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
import { nextRuleId } from "./ids.ts";
import { compareNewestRuns } from "./runs.ts";
import type { AutomationsRuntime } from "./runtime.ts";
import { nowIso } from "./time.ts";

export function commandName(name: AutomationCommandName) {
  return PluginCommandName.make(name);
}

export const registerAutomationCommands = (
  ctx: PluginActivationContext,
  runtime: AutomationsRuntime,
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
          const persistedRule = yield* runtime.saveRule(rule);
          return { rule: persistedRule };
        }),
    });

    yield* ctx.commands.register(commandName(AUTOMATIONS_COMMANDS.rulesUpdate), {
      input: AutomationsRulesUpdateInput,
      output: AutomationsRulesUpdateResult,
      handler: (input) =>
        Effect.gen(function* () {
          const persistedRule = yield* runtime.updateRule(input.ruleId, input.patch);
          return { rule: persistedRule };
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
