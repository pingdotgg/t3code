import type { IssueTemplateField } from "@t3tools/contracts";

export type IssueTemplateValues = Readonly<Record<string, string | ReadonlyArray<string>>>;

function isEmpty(value: string | ReadonlyArray<string> | undefined): boolean {
  return typeof value === "string" ? value.trim().length === 0 : (value?.length ?? 0) === 0;
}

function isChecked(value: string | ReadonlyArray<string> | undefined, label: string): boolean {
  return typeof value !== "string" && value !== undefined && value.includes(label);
}

export function initialTemplateValues(
  fields: ReadonlyArray<IssueTemplateField>,
): IssueTemplateValues {
  return Object.fromEntries(
    fields.flatMap((field) => {
      if (field.kind === "dropdown") {
        const defaults = field.defaultValues ?? [];
        return [[field.id, field.multiple ? defaults : (defaults[0] ?? "")]];
      }
      return (field.kind === "input" || field.kind === "textarea") && field.value
        ? [[field.id, field.value]]
        : [];
    }),
  );
}

export function composeTemplateBody(
  fields: ReadonlyArray<IssueTemplateField>,
  values: IssueTemplateValues,
): string {
  return fields
    .flatMap((field) => {
      if (field.kind === "markdown") return [];
      const value = values[field.id];
      if (field.kind === "checkboxes") {
        const lines = field.options.map(
          (option) => `- [${isChecked(value, option.label) ? "x" : " "}] ${option.label}`,
        );
        return [`### ${field.label}\n\n${lines.join("\n")}`];
      }
      const text = (typeof value === "string" ? value : (value ?? []).join(", ")).trim();
      const rendered =
        text.length === 0
          ? "_No response_"
          : field.kind === "textarea" && field.render
            ? `\`\`\`${field.render}\n${text}\n\`\`\``
            : text;
      return [`### ${field.label}\n\n${rendered}`];
    })
    .join("\n\n");
}

export function missingRequiredTemplateFields(
  fields: ReadonlyArray<IssueTemplateField>,
  values: IssueTemplateValues,
): string[] {
  return fields.flatMap((field) => {
    if (field.kind === "markdown") return [];
    const value = values[field.id];
    const missing =
      field.kind === "checkboxes"
        ? (field.required && isEmpty(value)) ||
          field.options.some((option) => option.required && !isChecked(value, option.label))
        : field.required && isEmpty(value);
    return missing ? [field.label] : [];
  });
}
