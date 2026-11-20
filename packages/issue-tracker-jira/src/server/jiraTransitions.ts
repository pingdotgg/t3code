import type {
  IssueTransition,
  IssueTransitionField,
  IssueTransitionFields,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { markdownToAdf, type AdfNode } from "./adf.ts";
import type { JiraTransition, JiraTransitionField } from "./JiraApi.ts";

const MAX_FIELDS = 100;
const MAX_OPTIONS = 200;
const EMPTY_FIELDS: IssueTransitionFields = {};

const iso = (value: string) =>
  Option.match(DateTime.make(value), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });

function choice(value: unknown, schema: JiraTransitionField["schema"]) {
  if (typeof value === "string" || typeof value === "number") {
    return { value: String(value), label: String(value), wire: value };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if ("children" in value) return null;
  const type = schema?.type === "array" ? schema.items : schema?.type;
  if (type === "user" && "accountId" in value && typeof value.accountId === "string") {
    const label =
      "displayName" in value && typeof value.displayName === "string"
        ? value.displayName
        : value.accountId;
    return { value: value.accountId, label, wire: { accountId: value.accountId } };
  }
  if (!["option", "resolution", "priority", "component", "version"].includes(type ?? ""))
    return null;
  if (!("id" in value) || (typeof value.id !== "string" && typeof value.id !== "number"))
    return null;
  const id = String(value.id);
  const label =
    "name" in value && typeof value.name === "string"
      ? value.name
      : "value" in value && typeof value.value === "string"
        ? value.value
        : id;
  return { value: id, label, wire: { id } };
}

function fieldType(id: string, field: JiraTransitionField): IssueTransitionField["type"] {
  const operations = field.operations;
  if (id === "comment")
    return operations === undefined || operations.includes("add") ? "multiline" : "unsupported";
  if (operations !== undefined && !operations.includes("set")) return "unsupported";
  const schema = field.schema;
  const values = field.allowedValues;
  if (values !== undefined && values.length > 0) {
    if (values.length > MAX_OPTIONS || values.some((value) => choice(value, schema) === null))
      return "unsupported";
    return schema?.type === "array" ? "multiselect" : "select";
  }
  if (schema?.type === "number" || schema?.type === "integer") return "number";
  if (schema?.type === "date" || schema?.custom?.endsWith(":datepicker")) return "date";
  if (schema?.type === "datetime" || schema?.custom?.endsWith(":datetime")) return "datetime";
  if (schema?.type === "string") {
    if (id === "description" || id === "environment" || schema.custom?.endsWith(":textarea"))
      return "multiline";
    // App fields can share a primitive schema while expecting their own wire format.
    if (
      schema.custom !== undefined &&
      !schema.custom.endsWith(":textfield") &&
      !schema.custom.endsWith(":url")
    )
      return "unsupported";
    return "text";
  }
  return "unsupported";
}

export function jiraTransition(transition: JiraTransition): IssueTransition {
  const fields = Object.entries(transition.fields ?? {});
  return {
    id: transition.id,
    name: transition.name,
    to: {
      name: transition.to.name,
      category: transition.to.statusCategory?.key === "done" ? "closed" : "open",
    },
    fields:
      fields.length > MAX_FIELDS ||
      (transition.hasScreen === true && transition.fields === undefined)
        ? [
            {
              id: "additional-fields",
              label: "This transition's full form is unavailable. Open it in Jira.",
              required: true,
              type: "unsupported",
              options: [],
            },
          ]
        : fields.map(([id, field]) => {
            const type = fieldType(id, field);
            return {
              id,
              label: field.name?.trim() || id,
              required: field.required === true,
              type,
              options:
                type === "select" || type === "multiselect"
                  ? (field.allowedValues ?? []).flatMap((value) => {
                      const option = choice(value, field.schema);
                      return option === null ? [] : [{ value: option.value, label: option.label }];
                    })
                  : [],
            };
          }),
  };
}

export function jiraTransitionValues(
  transition: JiraTransition,
  input = EMPTY_FIELDS,
):
  | { readonly fields?: Readonly<Record<string, unknown>>; readonly comment?: AdfNode }
  | { readonly error: string } {
  const metadata = transition.fields ?? {};
  const form = jiraTransition(transition);
  const fields: Record<string, unknown> = {};
  let comment: AdfNode | undefined;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(metadata, key))
      return {
        error: `The transition does not allow field "${key}". Refresh the issue and try again.`,
      };
  }
  for (const field of form.fields) {
    const value = Object.hasOwn(input, field.id) ? input[field.id] : undefined;
    if (field.required && field.type === "unsupported")
      return {
        error: `${field.label} must be completed in Jira. Open this issue in Jira to perform the transition.`,
      };
    const empty =
      value == null ||
      (typeof value === "string" && value.trim().length === 0) ||
      (Array.isArray(value) && value.length === 0);
    if (field.required && empty)
      return { error: `${field.label} is required for this transition.` };
    if (value === undefined) continue;
    if (field.type === "unsupported")
      return { error: `${field.label} cannot be changed here. Open this issue in Jira.` };
    if (value === null) {
      if (field.id !== "comment") fields[field.id] = null;
      continue;
    }
    const meta = metadata[field.id]!;
    const invalid = () => ({ error: `Enter a valid value for ${field.label}.` });
    switch (field.type) {
      case "select":
      case "multiselect": {
        const choices = (meta.allowedValues ?? []).flatMap((entry) => {
          const option = choice(entry, meta.schema);
          return option === null ? [] : [option];
        });
        if (field.type === "select") {
          if (typeof value !== "string") return invalid();
          const selected = choices.find((option) => option.value === value);
          if (selected === undefined) return invalid();
          fields[field.id] = selected.wire;
        } else {
          if (
            !Array.isArray(value) ||
            value.length > MAX_OPTIONS ||
            value.some((item) => typeof item !== "string")
          )
            return invalid();
          const selected = value.map((item) => choices.find((option) => option.value === item));
          if (selected.some((option) => option === undefined)) return invalid();
          fields[field.id] = selected.flatMap((option) =>
            option === undefined ? [] : [option.wire],
          );
        }
        break;
      }
      case "number":
        if (
          typeof value !== "number" ||
          !Number.isFinite(value) ||
          (meta.schema?.type === "integer" && !Number.isInteger(value))
        )
          return invalid();
        fields[field.id] = value;
        break;
      case "date":
        if (
          typeof value !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
          iso(`${value}T00:00:00.000Z`)?.slice(0, 10) !== value
        )
          return invalid();
        fields[field.id] = value;
        break;
      case "datetime":
        if (
          typeof value !== "string" ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/u.test(
            value,
          ) ||
          iso(value) === null
        )
          return invalid();
        // Jira documents datetimes with a `+0000` offset, as it writes them itself.
        fields[field.id] = iso(value)?.replace(/Z$/u, "+0000");
        break;
      case "text":
      case "multiline":
        if (typeof value !== "string" || value.length > 65536) return invalid();
        if (field.id === "comment") {
          if (!empty) comment = markdownToAdf(value);
        } else fields[field.id] = field.type === "multiline" ? markdownToAdf(value) : value;
        break;
    }
  }
  return {
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    ...(comment === undefined ? {} : { comment }),
  };
}
