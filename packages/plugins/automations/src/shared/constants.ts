export const AUTOMATIONS_PLUGIN_ID = "t3.automations" as const;

export const AUTOMATIONS_COMMANDS = {
  rulesList: "automations.rules.list",
  rulesCreate: "automations.rules.create",
  rulesUpdate: "automations.rules.update",
  rulesDelete: "automations.rules.delete",
  rulesRunNow: "automations.rules.runNow",
  runsListRecent: "automations.runs.listRecent",
} as const;

export type AutomationCommandName =
  (typeof AUTOMATIONS_COMMANDS)[keyof typeof AUTOMATIONS_COMMANDS];

export const AUTOMATIONS_EVENTS = {
  changed: "automations.changed",
} as const;

export const DEFAULT_CRON = "0 9 * * 1";
