import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import type { IssueFieldValues, IssueInputField } from "@t3tools/contracts";
import { boundedJiraJson } from "./jiraAdf.ts";
import { textToAdf } from "./jiraJson.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096));
export const jiraFormFieldLimit = 1000;
export const JiraField = Schema.Struct({
  fieldId: Schema.optional(Text),
  name: Schema.optional(Text.check(Schema.isMaxLength(1024))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  required: Schema.optional(Schema.Boolean),
  hasDefaultValue: Schema.optional(Schema.Boolean),
  operations: Schema.optional(Schema.Array(Text).check(Schema.isMaxLength(20))),
  schema: Schema.optional(
    Schema.Struct({
      type: Schema.optional(Text),
      items: Schema.optional(Text),
      custom: Schema.optional(Text),
      system: Schema.optional(Text),
    }),
  ),
  allowedValues: Schema.optional(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(100))),
  autoCompleteUrl: Schema.optional(Schema.String),
});
export type JiraFieldMetadata = typeof JiraField.Type;
export const createReserved = new Set([
  "project",
  "issuetype",
  "summary",
  "description",
  "labels",
  "assignee",
  "parent",
]);
export const transitionReserved = new Set(["project", "issuetype", "parent"]);
const forbidden = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "id",
  "key",
  "status",
  "created",
  "updated",
  "creator",
]);
const writable = (field: JiraFieldMetadata) =>
  field.operations === undefined || field.operations.includes("set");
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Jira option.");
  return value as Record<string, unknown>;
};
const option = (value: unknown) => {
  if (typeof value === "string") {
    if (!value.trim() || value.length > 1024) throw new Error("Invalid Jira option.");
    return { value, label: value, native: value };
  }
  const raw = record(value);
  const id =
    typeof raw.id === "string" ? raw.id : typeof raw.id === "number" ? String(raw.id) : undefined;
  const name =
    typeof raw.value === "string" ? raw.value : typeof raw.name === "string" ? raw.name : undefined;
  const key = id ?? name;
  if (
    !key ||
    key.length > 4096 ||
    !key.trim() ||
    (name?.length ?? 0) > 1024 ||
    (name !== undefined && !name.trim())
  )
    throw new Error("Invalid Jira option.");
  return { value: key, label: name ?? key, native: id === undefined ? { value: name } : { id } };
};
const cascadingOption = (value: unknown) => {
  const raw = record(value);
  const parent = option(raw);
  const children = raw.children ?? [];
  if (
    (typeof raw.id !== "string" && typeof raw.id !== "number") ||
    !Array.isArray(children) ||
    children.length > 100
  )
    throw new Error("Invalid Jira cascading options.");
  return {
    value: parent.value,
    label: parent.label,
    children: children.map((value) => {
      const raw = record(value);
      const child = option(raw);
      if (
        (typeof raw.id !== "string" && typeof raw.id !== "number") ||
        (raw.children !== undefined && (!Array.isArray(raw.children) || raw.children.length !== 0))
      )
        throw new Error("Invalid Jira cascading options.");
      return { value: child.value, label: child.label };
    }),
  };
};
function jiraInputField(id: string, field: JiraFieldMetadata): IssueInputField {
  if (!/^[a-zA-Z][a-zA-Z0-9_]{0,99}$/.test(id) || forbidden.has(id))
    throw new Error("Invalid Jira form field.");
  const type = field.schema?.type;
  const custom = field.schema?.custom;
  const cascading = custom === "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect";
  const builtin =
    custom === undefined || custom.startsWith("com.atlassian.jira.plugin.system.customfieldtypes:");
  const selectable =
    builtin &&
    ([
      "string",
      "option",
      "priority",
      "resolution",
      "version",
      "component",
      "securitylevel",
    ].includes(type ?? "") ||
      (type === "array" &&
        ["string", "option", "version", "component"].includes(field.schema?.items ?? "")));
  const options = cascading
    ? field.allowedValues?.map(cascadingOption)
    : selectable
      ? field.allowedValues?.map(option).map(({ value, label }) => ({ value, label }))
      : undefined;
  const kind: IssueInputField["kind"] = cascading
    ? "cascading-select"
    : !builtin
      ? "json"
      : type === "array" && options
        ? "multiselect"
        : options &&
            options.length > 0 &&
            [
              "string",
              "option",
              "priority",
              "resolution",
              "version",
              "component",
              "securitylevel",
            ].includes(type ?? "")
          ? "select"
          : type === "number"
            ? "number"
            : type === "date"
              ? "date"
              : type === "datetime"
                ? "datetime"
                : type === "string"
                  ? custom?.endsWith(":textarea") ||
                    ["description", "environment"].includes(field.schema?.system ?? "")
                    ? "textarea"
                    : "text"
                  : "json";
  return {
    id,
    label: field.name ?? id,
    required: field.required === true && field.hasDefaultValue !== true,
    kind,
    ...(field.description === undefined ? {} : { description: field.description }),
    ...(kind === "select" || kind === "multiselect" || kind === "cascading-select"
      ? { options }
      : {}),
  };
}

export function jiraInputFields(
  fields: Readonly<Record<string, JiraFieldMetadata>>,
  reserved: ReadonlySet<string>,
): IssueInputField[] {
  if (Object.keys(fields).length > jiraFormFieldLimit) throw new Error("Too many Jira fields.");
  return Object.entries(fields)
    .filter(([id, field]) => !reserved.has(id) && writable(field))
    .map(([id, field]) => jiraInputField(id, field));
}

export function jiraFieldValues(
  fields: Readonly<Record<string, JiraFieldMetadata>>,
  values: IssueFieldValues | undefined,
  reserved: ReadonlySet<string>,
  cloud: boolean,
): Record<string, unknown> {
  const entries = Object.entries(values ?? {});
  if (
    entries.length > jiraFormFieldLimit ||
    entries.reduce(
      (length, [id, value]) =>
        length +
        id.length +
        (typeof value === "string"
          ? value.length
          : value.reduce((sum, entry) => sum + entry.length, 0)),
      0,
    ) > 65_536
  )
    throw new Error("Too many Jira field values.");
  const result: Record<string, unknown> = {};
  for (const [id, value] of entries) {
    const field = Object.hasOwn(fields, id) ? fields[id] : undefined;
    if (!field || reserved.has(id) || !writable(field))
      throw new Error("Unknown or reserved Jira field.");
    const input = jiraInputField(id, field);
    if (
      typeof value !== "string" &&
      (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    )
      throw new Error("Invalid Jira field value.");
    if (
      typeof value === "string"
        ? value.length > 65_536
        : value.length > 100 || value.some((entry) => entry.length > 4096)
    )
      throw new Error("Jira field value exceeds its limit.");
    if (input.required && (value === "" || (Array.isArray(value) && value.length === 0)))
      throw new Error("This Jira form needs extra required fields.");
    if (input.kind === "multiselect") {
      if (!Array.isArray(value)) throw new Error("Select Jira field values.");
      result[id] = value.map((entry) => {
        const selected = field.allowedValues
          ?.map(option)
          .find((candidate) => candidate.value === entry);
        if (!selected) throw new Error("Invalid Jira selection.");
        return selected.native;
      });
    } else {
      if (typeof value !== "string") throw new Error("Enter one Jira field value.");
      if (input.kind === "cascading-select") {
        const selected = record(JSON.parse(value));
        if (
          typeof selected.id !== "string" ||
          Object.keys(selected).some((key) => key !== "id" && key !== "child")
        )
          throw new Error("Invalid Jira cascading selection.");
        const parent = input.options?.find((option) => option.value === selected.id);
        if (!parent) throw new Error("Invalid Jira cascading selection.");
        const child = selected.child === undefined ? undefined : record(selected.child);
        if (
          child !== undefined &&
          (typeof child.id !== "string" ||
            Object.keys(child).some((key) => key !== "id") ||
            !parent.children?.some((option) => option.value === child.id))
        )
          throw new Error("Invalid Jira cascading selection.");
        result[id] = {
          id: parent.value,
          ...(child === undefined ? {} : { child: { id: child.id } }),
        };
      } else if (input.kind === "select") {
        const selected = field.allowedValues
          ?.map(option)
          .find((candidate) => candidate.value === value);
        if (!selected) throw new Error("Invalid Jira selection.");
        result[id] = selected.native;
      } else if (input.kind === "number") {
        if (
          !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ||
          !Number.isFinite(Number(value))
        )
          throw new Error("Invalid Jira number.");
        result[id] = Number(value);
      } else if (input.kind === "date") {
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
          !Number.isFinite(Date.parse(value)) ||
          DateTime.formatIso(DateTime.makeUnsafe(value)).slice(0, 10) !== value
        )
          throw new Error("Invalid Jira date.");
        result[id] = value;
      } else if (input.kind === "datetime") {
        if (
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})$/.test(
            value,
          ) ||
          !Number.isFinite(Date.parse(value))
        )
          throw new Error("Invalid Jira date and time.");
        result[id] = value;
      } else if (input.kind === "json") {
        const parsed: unknown = JSON.parse(value);
        boundedJiraJson(parsed);
        result[id] = parsed;
      } else result[id] = input.kind === "textarea" && cloud ? textToAdf(value) : value;
    }
  }
  for (const [id, field] of Object.entries(fields)) {
    if (reserved.has(id) || !field.required || field.hasDefaultValue) continue;
    const value = result[id];
    if (
      !writable(field) ||
      value === undefined ||
      value === null ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
    )
      throw new Error("This Jira form needs extra required fields.");
  }
  return result;
}
