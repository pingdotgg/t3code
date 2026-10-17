import { expect, it } from "@effect/vitest";
import { readGitHubIssueTemplateFiles } from "./gitHubIssueTemplates.ts";

it.each([false, true])("preserves forms with %s explicit field IDs", (explicit) => {
  const result = readGitHubIssueTemplateFiles([
    {
      name: "bug.yml",
      object: {
        text: `name: Bug\ndescription: Report a bug\nbody:\n- type: textarea\n${explicit ? "  id: details\n" : ""}  attributes: {label: Details}\n- type: input\n${explicit ? "  id: other\n" : ""}  attributes: {label: Other}`,
      },
    },
  ]);
  expect(result.templates[0]?.fields?.map((field) => ("id" in field ? field.id : null))).toEqual(
    explicit ? ["details", "other"] : ["field-0", "field-1"],
  );
});

it.each([0, 1])("preserves dropdown option %i as the native default", (index) => {
  const result = readGitHubIssueTemplateFiles([
    {
      name: "bug.yml",
      object: {
        text: `name: Bug\ndescription: Report a bug\nbody:\n  - type: dropdown\n    id: version\n    attributes:\n      label: Version\n      options: [Stable, Preview]\n      default: ${index}\n`,
      },
    },
  ]);
  expect(result.templates[0]?.fields?.[0]).toMatchObject({
    kind: "dropdown",
    defaultValues: [["Stable", "Preview"][index]],
  });
});

it.each([-1, 2, 1.5])("ignores invalid dropdown default %s", (index) => {
  const result = readGitHubIssueTemplateFiles([
    {
      name: "bug.yml",
      object: {
        text: `name: Bug\ndescription: Report a bug\nbody:\n  - type: dropdown\n    id: version\n    attributes:\n      label: Version\n      options: [Stable, Preview]\n      default: ${index}\n`,
      },
    },
  ]);
  expect(result.templates[0]?.fields?.[0]).toMatchObject({
    kind: "dropdown",
    options: ["Stable", "Preview"],
  });
  expect(result.templates[0]?.fields?.[0]).not.toHaveProperty("defaultValues");
});
