import { readFile } from "node:fs/promises";

import { AI_LOOP_SCHEMA_VERSION, type AiLoopConfig } from "./schema";

const assertRecord = (value: unknown, context: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }

  return value as Record<string, unknown>;
};

const readBoolean = (record: Record<string, unknown>, key: string): boolean => {
  const value = record[key];
  if (typeof value !== "boolean") {
    throw new Error(`Expected "${key}" to be a boolean.`);
  }

  return value;
};

const readNumber = (record: Record<string, unknown>, key: string): number => {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected "${key}" to be a finite number.`);
  }

  return value;
};

const readString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`Expected "${key}" to be a string.`);
  }

  return value;
};

const readStringArray = (record: Record<string, unknown>, key: string): string[] => {
  const value = record[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Expected "${key}" to be an array of strings.`);
  }

  return [...value];
};

export const loadAiLoopConfig = async (
  configPath = ".github/ai-loop.yml",
): Promise<AiLoopConfig> => {
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const record = assertRecord(parsed, "AI loop config");

  const config: AiLoopConfig = {
    schema_version: readNumber(record, "schema_version"),
    enabled: readBoolean(record, "enabled"),
    trusted_review_bots: readStringArray(record, "trusted_review_bots"),
    trusted_humans: readStringArray(record, "trusted_humans"),
    human_trigger_phrase: readString(record, "human_trigger_phrase"),
    executor_owner: readString(record, "executor_owner"),
    executor_bot_login: readString(record, "executor_bot_login"),
    attempt_budget_per_generation: readNumber(record, "attempt_budget_per_generation"),
    debounce_seconds: readNumber(record, "debounce_seconds"),
    debounce_max_seconds: readNumber(record, "debounce_max_seconds"),
    dispatch_grace_seconds: readNumber(record, "dispatch_grace_seconds"),
    executor_timeout_seconds: readNumber(record, "executor_timeout_seconds"),
    pause_label: readString(record, "pause_label"),
    required_ci_checks: readStringArray(record, "required_ci_checks"),
    prepush_commands: readStringArray(record, "prepush_commands"),
    legacy_workflows_present: readStringArray(record, "legacy_workflows_present"),
  };

  if (config.schema_version !== AI_LOOP_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported AI loop config schema ${config.schema_version}. Expected ${AI_LOOP_SCHEMA_VERSION}.`,
    );
  }

  return config;
};
