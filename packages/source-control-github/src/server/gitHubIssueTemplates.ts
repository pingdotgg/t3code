import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";
import { IssueTrackerKind, TrimmedNonEmptyString, type IssueTemplate } from "@t3tools/contracts";
import { IssueTrackerError } from "@t3tools/source-control-core/server/IssueTracker";

import type * as Issues from "./issues.graphql.ts";
import { toIssueTemplates } from "./gitHubIssueJson.ts";

const Names = Schema.Union([Schema.String, Schema.Array(Schema.String)]);
const FormOption = Schema.Union([
  Schema.String,
  Schema.Struct({ label: Schema.String, required: Schema.optional(Schema.Boolean) }),
]);
const FormField = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  attributes: Schema.optional(
    Schema.Struct({
      label: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
      value: Schema.optional(Schema.String),
      placeholder: Schema.optional(Schema.String),
      render: Schema.optional(Schema.String),
      multiple: Schema.optional(Schema.Boolean),
      default: Schema.optional(Schema.Union([Schema.Int, Schema.Array(Schema.Int)])),
      options: Schema.optional(Schema.Array(FormOption)),
    }),
  ),
  validations: Schema.optional(
    Schema.Struct({
      required: Schema.optional(Schema.Boolean),
      accept: Schema.optional(Schema.String),
    }),
  ),
});
const decodeForm = Schema.decodeUnknownSync(
  Schema.Struct({
    name: TrimmedNonEmptyString,
    description: Schema.String,
    title: Schema.optional(Schema.String),
    labels: Schema.optional(Names),
    assignees: Schema.optional(Names),
    body: Schema.Array(FormField),
  }),
);
const decodeConfig = Schema.decodeUnknownSync(
  Schema.Struct({ blank_issues_enabled: Schema.optional(Schema.Boolean) }),
);

function names(value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return (typeof value === "string" ? value.split(",") : (value ?? []))
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function fieldMarkdown(field: typeof FormField.Type): string {
  const attributes = field.attributes;
  if (field.type === "markdown") return attributes?.value ?? "";

  const sections = [`### ${attributes?.label ?? field.id ?? field.type}`];
  if (attributes?.description) sections.push(attributes.description);
  if (field.validations?.required) sections.push("Required.");
  if (attributes?.placeholder)
    sections.push(`Example:\n> ${attributes.placeholder.trim().replaceAll("\n", "\n> ")}`);
  if (attributes?.render) sections.push(`Format: ${attributes.render}`);
  if (field.validations?.accept) sections.push(`Accepted files: ${field.validations.accept}`);

  const options = attributes?.options ?? [];
  if (field.type === "checkboxes") {
    sections.push(
      options
        .map((option) => {
          const label = typeof option === "string" ? option : option.label;
          const required = typeof option !== "string" && option.required;
          return `- [ ] ${label}${required ? " (required)" : ""}`;
        })
        .join("\n"),
    );
  } else if (field.type === "dropdown") {
    const defaults = attributes?.default;
    const defaultIndices = typeof defaults === "number" ? [defaults] : (defaults ?? []);
    sections.push(attributes?.multiple ? "Choose one or more:" : "Choose one:");
    sections.push(
      options
        .map((option, index) => {
          const label = typeof option === "string" ? option : option.label;
          return `- ${label}${defaultIndices.includes(index) ? " (default)" : ""}`;
        })
        .join("\n"),
    );
  }
  if (attributes?.value) sections.push(attributes.value);
  return sections.filter(Boolean).join("\n\n");
}

export const readIssueTemplates = Effect.fnUntraced(function* (
  repository: NonNullable<Issues.IssueTemplates.Result["repository"]>,
) {
  const templates = new Map<string, IssueTemplate>(
    toIssueTemplates(repository).map((template) => [
      template.key.slice(template.key.lastIndexOf("/") + 1),
      template,
    ]),
  );
  let blankIssuesEnabled = true;
  const directory = repository.templateDirectory;
  for (const entry of directory?.__typename === "Tree" ? (directory.entries ?? []) : []) {
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    const blob = entry.object;
    if (blob?.__typename !== "Blob" || blob.isTruncated || blob.text === null) {
      return yield* new IssueTrackerError({
        tracker: IssueTrackerKind.make("github"),
        operation: "listTemplates",
        reason: "failed",
        detail: "GitHub returned incomplete issue template contents.",
      });
    }
    const text = blob.text;
    const isConfig = /^config\.ya?ml$/i.test(entry.name);
    const parsed = yield* Effect.try({
      try: () => {
        const document: unknown = parseYaml(text);
        if (isConfig) {
          return { config: decodeConfig(document ?? {}) };
        }
        return { form: decodeForm(document) };
      },
      catch: (cause) =>
        new IssueTrackerError({
          tracker: IssueTrackerKind.make("github"),
          operation: "listTemplates",
          reason: "failed",
          detail: "The repository has an unreadable issue template or configuration.",
          cause,
        }),
    }).pipe(Effect.result);
    if (Result.isFailure(parsed)) {
      if (isConfig) return yield* parsed.failure;
      continue;
    }
    if (parsed.success.config !== undefined) {
      blankIssuesEnabled = parsed.success.config.blank_issues_enabled ?? true;
    } else if (parsed.success.form !== undefined) {
      const form = parsed.success.form;
      templates.set(entry.name, {
        key: entry.name,
        name: form.name,
        about: form.description,
        title: form.title ?? "",
        labels: names(form.labels),
        assignees: names(form.assignees),
        body: form.body.map(fieldMarkdown).filter(Boolean).join("\n\n"),
      });
    }
  }
  return { templates: [...templates.values()], blankIssuesEnabled };
});
