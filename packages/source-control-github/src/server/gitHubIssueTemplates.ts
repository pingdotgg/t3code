import {
  TrimmedNonEmptyString,
  type IssueTemplate,
  type IssueTemplateField,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromYaml } from "@t3tools/shared/schemaYaml";

const NonBlank = Schema.String.check(Schema.isPattern(/\S/));
const Field = Schema.Struct({
  type: Schema.Literals(["markdown", "input", "textarea", "dropdown", "checkboxes", "upload"]),
  id: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))),
  attributes: Schema.Struct({
    label: Schema.optional(NonBlank),
    description: Schema.optional(Schema.String),
    placeholder: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    render: Schema.optional(Schema.String),
    multiple: Schema.optional(Schema.Boolean),
    default: Schema.optional(Schema.Number),
    options: Schema.optional(
      Schema.Array(
        Schema.Union([
          NonBlank,
          Schema.Struct({
            label: NonBlank,
            required: Schema.optional(Schema.Boolean),
          }),
        ]),
      ).check(Schema.isMinLength(1)),
    ),
  }),
  validations: Schema.optional(Schema.Struct({ required: Schema.optional(Schema.Boolean) })),
}).check(
  Schema.makeFilter((field) => {
    if (field.type === "markdown") return (field.attributes.value?.trim().length ?? 0) > 0;
    if (field.attributes.label === undefined) return false;
    if (field.type === "dropdown")
      return field.attributes.options?.every((option) => typeof option === "string") === true;
    if (field.type === "checkboxes")
      return field.attributes.options?.every((option) => typeof option !== "string") === true;
    return true;
  }),
);
const Form = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  title: Schema.optional(Schema.String),
  body: Schema.Array(Field).check(
    Schema.isMinLength(1),
    Schema.makeFilter((body) => body.some((field) => field.type !== "markdown")),
    Schema.makeFilter((body) => {
      const ids = body.flatMap((field) => (field.id === undefined ? [] : [field.id]));
      return new Set(ids).size === ids.length;
    }),
  ),
  labels: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  assignees: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
});
const Markdown = Schema.Struct({
  name: NonBlank,
  about: NonBlank,
});
const Config = Schema.Struct({
  blank_issues_enabled: Schema.optional(Schema.Boolean),
  contact_links: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, about: Schema.String, url: Schema.String })),
  ),
});

function readYaml<S extends Schema.Top & { readonly DecodingServices: never }>(
  text: string,
  schema: S,
) {
  return Option.getOrUndefined(Schema.decodeUnknownOption(fromYaml(schema))(text));
}
const names = (value: string | ReadonlyArray<string> | undefined) =>
  typeof value === "string"
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : (value ?? []);

export function readGitHubIssueTemplateFiles(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly object: { readonly text?: string | null | undefined } | null;
  }>,
) {
  const templates: IssueTemplate[] = [];
  const externalTemplates: Array<Pick<IssueTemplate, "key" | "name" | "about">> = [];
  let hasConfig = false;
  const markdownNames: string[] = [];
  let config = {
    blankIssuesEnabled: true,
    contactLinks: [] as ReadonlyArray<{
      readonly name: string;
      readonly about: string;
      readonly url: string;
    }>,
  };
  for (const entry of entries) {
    if (entry.object?.text == null) continue;
    if (/\.md$/i.test(entry.name)) {
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(entry.object.text);
      if (frontmatter !== null && readYaml(frontmatter[1]!, Markdown) !== undefined)
        markdownNames.push(entry.name);
      continue;
    }
    if (!/\.ya?ml$/i.test(entry.name)) continue;
    if (/^config\.ya?ml$/i.test(entry.name)) {
      const parsed = readYaml(entry.object.text, Config);
      if (parsed !== undefined) {
        hasConfig = true;
        config = {
          blankIssuesEnabled: parsed.blank_issues_enabled ?? true,
          contactLinks: parsed.contact_links ?? [],
        };
      }
      continue;
    }
    const parsed = readYaml(entry.object.text, Form);
    if (parsed === undefined) continue;
    if (parsed.body.some((field) => field.type === "upload")) {
      externalTemplates.push({ key: entry.name, name: parsed.name, about: parsed.description });
      continue;
    }
    const fields = parsed.body.map((field, index): IssueTemplateField => {
      const attributes = field.attributes;
      if (field.type === "markdown") return { kind: "markdown", value: attributes.value ?? "" };
      const base = {
        id: field.id ?? `field-${index}`,
        label: attributes.label ?? "",
        description: attributes.description ?? null,
        required: field.validations?.required ?? false,
      };
      if (field.type === "input")
        return {
          ...base,
          kind: "input",
          placeholder: attributes.placeholder ?? null,
          value: attributes.value ?? null,
        };
      if (field.type === "textarea")
        return {
          ...base,
          kind: "textarea",
          placeholder: attributes.placeholder ?? null,
          value: attributes.value ?? null,
          render: attributes.render ?? null,
        };
      if (field.type === "dropdown") {
        const options = (attributes.options ?? []).map((option) =>
          typeof option === "string" ? option : option.label,
        );
        const defaultIndex = attributes.default;
        return {
          ...base,
          kind: "dropdown",
          multiple: attributes.multiple ?? false,
          options,
          ...(defaultIndex !== undefined &&
          Number.isInteger(defaultIndex) &&
          defaultIndex >= 0 &&
          defaultIndex < options.length
            ? { defaultValues: [options[defaultIndex]!] }
            : {}),
        };
      }
      return {
        ...base,
        kind: "checkboxes",
        options: (attributes.options ?? []).map((option) =>
          typeof option === "string"
            ? { label: option, required: false }
            : { label: option.label, required: option.required ?? false },
        ),
      };
    });
    templates.push({
      key: entry.name,
      name: parsed.name,
      about: parsed.description,
      title: parsed.title ?? "",
      body: "",
      fields,
      labels: names(parsed.labels),
      assignees: names(parsed.assignees),
    });
  }
  return {
    templates,
    externalTemplates,
    hasForms: templates.length > 0 || externalTemplates.length > 0,
    markdownNames,
    hasConfig,
    ...config,
  };
}
