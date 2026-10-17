import { expect, it } from "@effect/vitest";
import {
  createReserved,
  transitionReserved,
  jiraFieldValues,
  jiraInputFields,
  type JiraFieldMetadata,
} from "./jiraForms.ts";

const metadata: Record<string, JiraFieldMetadata> = {
  customfield_1: {
    name: "Notes",
    required: true,
    schema: {
      type: "string",
      custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea",
    },
  },
  customfield_2: { name: "When", schema: { type: "date" } },
  customfield_3: { name: "At", schema: { type: "datetime" } },
  customfield_4: {
    name: "Choices",
    schema: { type: "array", items: "option" },
    allowedValues: [
      { id: "1", value: "One" },
      { id: "2", value: "Two" },
    ],
  },
  customfield_5: {
    name: "Plugin",
    schema: { type: "string", custom: "plugin:object" },
    allowedValues: ["opaque"],
  },
  customfield_6: {
    name: "Default",
    required: true,
    hasDefaultValue: true,
    schema: { type: "string" },
  },
};
it("sends native dates, multi-select options, ADF textarea and explicit plugin JSON", () => {
  const values = {
    customfield_1: "Notes",
    customfield_2: "2026-10-15",
    customfield_3: "2026-10-15T12:30:00Z",
    customfield_4: ["2", "1"],
    customfield_5: '{"native":true}',
  };
  const result = jiraFieldValues(metadata, values, createReserved, true);
  expect(result).toMatchObject({
    customfield_1: { type: "doc", version: 1 },
    customfield_2: values.customfield_2,
    customfield_3: values.customfield_3,
    customfield_4: [{ id: "2" }, { id: "1" }],
    customfield_5: { native: true },
  });
  expect(result).not.toHaveProperty("customfield_6");
  expect(jiraFieldValues(metadata, values, createReserved, false).customfield_1).toBe("Notes");
  expect(jiraInputFields(metadata, createReserved)).toContainEqual({
    id: "customfield_6",
    label: "Default",
    required: false,
    kind: "text",
  });
});
it.each(["", "2026-02-30", "2026-13-01", "15/10/2026"])("rejects invalid dates: %s", (value) => {
  expect(() =>
    jiraFieldValues(
      { customfield_2: metadata.customfield_2! },
      { customfield_2: value },
      createReserved,
      true,
    ),
  ).toThrow();
});
it("preserves required transition fields, including native descriptions", () => {
  const fields = {
    description: {
      required: true,
      name: "Description",
      schema: { type: "string", system: "description" },
    },
  };
  expect(jiraInputFields(fields, transitionReserved)).toEqual([
    { id: "description", label: "Description", required: true, kind: "textarea" },
  ]);
  expect(() => jiraFieldValues(fields, {}, transitionReserved, true)).toThrow();
  expect(
    jiraFieldValues(fields, { description: "Required" }, transitionReserved, true),
  ).toMatchObject({ description: { type: "doc" } });
});
it("refuses immutable fields, non-settable fields, missing required values and unsafe JSON", () => {
  expect(() =>
    jiraInputFields({ status: { schema: { type: "string" } } }, transitionReserved),
  ).toThrow();
  expect(() =>
    jiraFieldValues(
      { customfield_1: { required: true, operations: ["add"], schema: { type: "string" } } },
      {},
      createReserved,
      true,
    ),
  ).toThrow();
  expect(() => jiraFieldValues(metadata, { customfield_1: "" }, createReserved, true)).toThrow();
  expect(() =>
    jiraFieldValues(
      metadata,
      { customfield_1: "a", customfield_5: '{"constructor":{}}' },
      createReserved,
      true,
    ),
  ).toThrow();
});
it("uses native string options and unknown schema objects without losing values", () => {
  const fields = {
    customfield_7: {
      name: "String choice",
      schema: { type: "string" },
      allowedValues: ["red", "blue"],
    },
    customfield_8: {
      name: "String choices",
      schema: { type: "array", items: "string" },
      allowedValues: ["red", "blue"],
    },
    customfield_9: { name: "Unknown", schema: {} },
  };
  expect(jiraInputFields(fields, createReserved).map((field) => field.kind)).toEqual([
    "select",
    "multiselect",
    "json",
  ]);
  expect(
    jiraFieldValues(
      fields,
      { customfield_7: "red", customfield_8: ["blue"], customfield_9: '{"native":1}' },
      createReserved,
      true,
    ),
  ).toEqual({ customfield_7: "red", customfield_8: ["blue"], customfield_9: { native: 1 } });
});
it("keeps 1000 editable fields and required values but rejects 1001", () => {
  const fields = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [
      "customfield_" + index,
      { required: true, schema: { type: "string" } },
    ]),
  );
  const values = Object.fromEntries(Object.keys(fields).map((id) => [id, "Set"]));
  expect(jiraInputFields(fields, createReserved)).toHaveLength(1000);
  expect(jiraFieldValues(fields, values, createReserved, true)).toEqual(values);
  fields.customfield_1000 = { required: true, schema: { type: "string" } };
  values.customfield_1000 = "Set";
  expect(() => jiraInputFields(fields, createReserved)).toThrow();
  expect(() => jiraFieldValues(fields, values, createReserved, true)).toThrow();
});

const cascadingField = {
  name: "Location",
  required: true,
  schema: {
    type: "array",
    items: "string",
    custom: "com.atlassian.jira.plugin.system.customfieldtypes:cascadingselect",
  },
  allowedValues: [
    { id: "10", value: "A", children: [{ id: "11", value: "A1" }] },
    { id: "20", value: "B", children: [{ id: "21", value: "B1" }] },
  ],
};
it.each(["array", "option"])("keeps native cascading options for schema %s", (type) => {
  const fields = {
    customfield_1: { ...cascadingField, schema: { ...cascadingField.schema, type } },
  };
  expect(jiraInputFields(fields, createReserved)).toEqual([
    {
      id: "customfield_1",
      label: "Location",
      required: true,
      kind: "cascading-select",
      options: [
        { value: "10", label: "A", children: [{ value: "11", label: "A1" }] },
        { value: "20", label: "B", children: [{ value: "21", label: "B1" }] },
      ],
    },
  ]);
  for (const value of ['{"id":"10","child":{"id":"11"}}', '{"id":"20"}'])
    expect(jiraFieldValues(fields, { customfield_1: value }, createReserved, true)).toEqual({
      customfield_1: JSON.parse(value),
    });
});
it.each([
  '{"id":"10","child":{"id":"21"}}',
  '{"id":"unknown"}',
  '{"id":"10","child":{"id":"11","child":{"id":"12"}}}',
  '{"id":"10","extra":true}',
  '{"id":"10","__proto__":{}}',
  "[]",
  "null",
  '["10","11"]',
  '{"id":10}',
  "invalid",
])("rejects malformed or foreign cascading values: %s", (value) => {
  expect(() =>
    jiraFieldValues(
      { customfield_1: cascadingField },
      { customfield_1: value },
      createReserved,
      true,
    ),
  ).toThrow();
});
it("rejects oversized cascading children and keeps required defaults", () => {
  expect(() =>
    jiraInputFields(
      {
        customfield_1: {
          ...cascadingField,
          allowedValues: [
            {
              id: "10",
              value: "A",
              children: Array.from({ length: 101 }, (_, i) => ({
                id: String(i),
                value: String(i),
              })),
            },
          ],
        },
      },
      createReserved,
    ),
  ).toThrow();
  const fields = { customfield_1: { ...cascadingField, hasDefaultValue: true } };
  expect(jiraInputFields(fields, createReserved)[0]?.required).toBe(false);
  expect(jiraFieldValues(fields, {}, createReserved, true)).toEqual({});
  expect(() =>
    jiraFieldValues({ customfield_1: cascadingField }, {}, createReserved, true),
  ).toThrow();
});
