import type { IssueTemplateField } from "@t3tools/contracts";
import { nativeFieldError, nativeFieldValues } from "./IssueNativeFields";
import { describe, expect, it } from "vite-plus/test";

import {
  composeTemplateBody,
  initialTemplateValues,
  missingRequiredTemplateFields,
} from "./issueCreate.logic";

const fields: IssueTemplateField[] = [
  { kind: "markdown", value: "Thanks for reporting." },
  {
    kind: "input",
    id: "version",
    label: "Version",
    description: null,
    required: true,
    placeholder: null,
    value: null,
  },
  {
    kind: "textarea",
    id: "logs",
    label: "Logs",
    description: null,
    required: false,
    placeholder: null,
    value: null,
    render: "shell",
  },
  {
    kind: "dropdown",
    id: "os",
    label: "OS",
    description: null,
    required: false,
    multiple: true,
    options: ["macOS", "Linux"],
  },
  {
    kind: "checkboxes",
    id: "terms",
    label: "Terms",
    description: null,
    required: false,
    options: [
      { label: "I searched", required: true },
      { label: "I can help", required: false },
    ],
  },
];

describe("initialTemplateValues", () => {
  it("seeds dropdowns from their defaults and text fields from their values", () => {
    const dropdown = (id: string, multiple: boolean, defaultValues?: string[]) => ({
      kind: "dropdown" as const,
      id,
      label: id,
      description: null,
      required: false,
      multiple,
      options: ["macOS", "Linux"],
      ...(defaultValues ? { defaultValues } : {}),
    });
    expect(
      initialTemplateValues([
        {
          kind: "textarea",
          id: "logs",
          label: "Logs",
          description: null,
          required: false,
          placeholder: null,
          value: "1.0",
          render: null,
        },
        dropdown("os", true, ["Linux"]),
        dropdown("one", false, ["macOS"]),
        dropdown("none", true),
      ]),
    ).toEqual({ logs: "1.0", os: ["Linux"], one: "macOS", none: [] });
  });
});

describe("composeTemplateBody", () => {
  it("writes GitHub issue-form sections and skips markdown", () => {
    expect(
      composeTemplateBody(fields, {
        version: " 1.2 ",
        logs: "boom",
        os: ["macOS", "Linux"],
        terms: ["I searched"],
      }),
    ).toBe(
      [
        "### Version\n\n1.2",
        "### Logs\n\n```shell\nboom\n```",
        "### OS\n\nmacOS, Linux",
        "### Terms\n\n- [x] I searched\n- [ ] I can help",
      ].join("\n\n"),
    );
  });

  it("says no response for empty answers instead of an empty fence", () => {
    expect(composeTemplateBody(fields.slice(1, 3), {})).toBe(
      "### Version\n\n_No response_\n\n### Logs\n\n_No response_",
    );
  });
});

describe("missingRequiredTemplateFields", () => {
  it("names required fields and unchecked required checkboxes", () => {
    expect(missingRequiredTemplateFields(fields, { version: "  " })).toEqual(["Version", "Terms"]);
    expect(missingRequiredTemplateFields(fields, { version: "1", terms: ["I searched"] })).toEqual(
      [],
    );
  });
});

it("requires a selection for a required checkbox group even when its choices are optional", () => {
  const fields: IssueTemplateField[] = [
    {
      kind: "checkboxes",
      id: "checks",
      label: "Checks",
      description: null,
      required: true,
      options: [
        { label: "First", required: false },
        { label: "Second", required: false },
      ],
    },
  ];
  expect(missingRequiredTemplateFields(fields, {})).toEqual(["Checks"]);
  expect(missingRequiredTemplateFields(fields, { checks: [] })).toEqual(["Checks"]);
  expect(missingRequiredTemplateFields(fields, { checks: ["First"] })).toEqual([]);
});

describe("native field values", () => {
  it("rejects missing and invalid fields and excludes stale values", () => {
    const fields = [
      { id: "native", label: "Native field", kind: "json" as const, required: true },
      {
        id: "choice",
        label: "Choice",
        kind: "multiselect" as const,
        required: false,
        options: [{ value: "native-id", label: "Native label" }],
      },
    ];
    expect(nativeFieldError(fields, {})).toBe("Fill in Native field.");
    expect(nativeFieldError(fields, { native: "invalid" })).toBe(
      "Enter valid JSON for Native field.",
    );
    expect(nativeFieldError(fields, { native: "{}", choice: ["wrong"] })).toBe(
      "Choose values for Choice.",
    );
    const values = { native: "{}", choice: ["native-id"], stale: "old issue type value" };
    expect(nativeFieldError(fields, values)).toBeNull();
    expect(nativeFieldValues(fields, values)).toEqual({ native: "{}", choice: ["native-id"] });
    expect(
      nativeFieldError([{ id: "when", label: "When", kind: "datetime", required: true }], {
        when: "invalid",
      }),
    ).toBe("Enter a date and time for When.");
  });
});

it("omits cleared optional typed fields while keeping text clears and explicit values", () => {
  const fields = [
    { id: "number", label: "Number", kind: "number" as const, required: false },
    { id: "date", label: "Date", kind: "date" as const, required: false },
    { id: "datetime", label: "Date and time", kind: "datetime" as const, required: false },
    {
      id: "select",
      label: "Choice",
      kind: "select" as const,
      required: false,
      options: [{ value: "native-id", label: "Native choice" }],
    },
    { id: "json", label: "JSON", kind: "json" as const, required: false },
    { id: "text", label: "Text", kind: "text" as const, required: false },
    { id: "textarea", label: "Long text", kind: "textarea" as const, required: false },
    {
      id: "multi",
      label: "Choices",
      kind: "multiselect" as const,
      required: false,
      options: [{ value: "native-id", label: "Native choice" }],
    },
  ];
  const cleared = {
    number: "",
    date: "",
    datetime: "",
    select: "",
    json: " ",
    text: "",
    textarea: "",
    multi: [],
  };
  expect(nativeFieldError(fields, cleared)).toBeNull();
  expect(nativeFieldValues(fields, cleared)).toEqual({ text: "", textarea: "", multi: [] });
  const explicit = {
    number: "0",
    date: "2026-06-01",
    datetime: "2026-06-01T09:30",
    select: "native-id",
    json: "null",
    text: "",
    textarea: "",
    multi: ["native-id"],
  };
  expect(nativeFieldError(fields, explicit)).toBeNull();
  expect(nativeFieldValues(fields, explicit)).toEqual({
    ...explicit,
    datetime: new Date(2026, 5, 1, 9, 30).toISOString(),
  });
  const blankChoice = [
    {
      id: "select",
      label: "Choice",
      kind: "select" as const,
      required: false,
      options: [{ value: "", label: "Native blank choice" }],
    },
  ];
  expect(nativeFieldValues(blankChoice, { select: "" })).toEqual({ select: "" });
});
