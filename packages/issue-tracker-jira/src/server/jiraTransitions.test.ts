import { describe, expect, it } from "@effect/vitest";

import type { JiraTransition } from "./JiraApi.ts";
import { jiraTransition, jiraTransitionValues } from "./jiraTransitions.ts";

const transition: JiraTransition = {
  id: "31",
  name: "Resolve",
  to: { name: "Done", statusCategory: { key: "done" } },
  fields: {
    resolution: {
      name: "Resolution",
      required: true,
      schema: { type: "resolution" },
      allowedValues: [{ id: "1", name: "Fixed" }],
      operations: ["set"],
    },
    summary: { name: "Summary", schema: { type: "string" } },
    estimate: { name: "Estimate", schema: { type: "number" } },
    due: { name: "Due", schema: { type: "date" } },
    at: { name: "Scheduled", schema: { type: "datetime" } },
    description: { name: "Description", schema: { type: "string" } },
    comment: { name: "Comment", schema: { type: "array", items: "comment" }, operations: ["add"] },
    components: {
      name: "Components",
      schema: { type: "array", items: "component" },
      allowedValues: [{ id: "5", name: "Web" }],
    },
    assignee: {
      name: "Assignee",
      schema: { type: "user" },
      allowedValues: [{ accountId: "u1", displayName: "Alice" }],
    },
  },
};

describe("jiraTransitions", () => {
  it("normalizes form controls and encodes only values its current metadata permits", () => {
    expect(jiraTransition(transition)).toMatchObject({
      id: "31",
      name: "Resolve",
      to: { name: "Done", category: "closed" },
      fields: [
        {
          id: "resolution",
          type: "select",
          required: true,
          options: [{ value: "1", label: "Fixed" }],
        },
        { id: "summary", type: "text" },
        { id: "estimate", type: "number" },
        { id: "due", type: "date" },
        { id: "at", type: "datetime" },
        { id: "description", type: "multiline" },
        { id: "comment", type: "multiline" },
        { id: "components", type: "multiselect" },
        { id: "assignee", type: "select" },
      ],
    });
    const values = jiraTransitionValues(transition, {
      resolution: "1",
      summary: "Ready",
      estimate: 0,
      due: "2026-11-17",
      at: "2026-11-17T13:00:00-08:00",
      description: "The fix",
      comment: "Verified",
      components: ["5"],
      assignee: "u1",
    });
    expect(values).toMatchObject({
      fields: {
        resolution: { id: "1" },
        summary: "Ready",
        estimate: 0,
        due: "2026-11-17",
        at: "2026-11-17T21:00:00.000+0000",
        description: { type: "doc" },
        components: [{ id: "5" }],
        assignee: { accountId: "u1" },
      },
      comment: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "Verified" }] }],
      },
    });
    expect(jiraTransitionValues(transition, { resolution: "1", summary: null })).toEqual({
      fields: { resolution: { id: "1" }, summary: null },
    });
    for (const invalid of [
      {},
      { resolution: "" },
      { resolution: { id: "1" } },
      { resolution: "1", admin: true },
      { resolution: "1", estimate: "0" },
      { resolution: "1", due: "2026-02-30" },
      { resolution: "1", at: "2026-11-17T13:00" },
      { resolution: "1", components: ["6"] },
      { resolution: "1", description: { type: "doc" } },
    ])
      expect(jiraTransitionValues(transition, invalid)).toHaveProperty("error");
  });

  it("requires Jira for missing, unsupported, truncated or unwriteable required controls", () => {
    const variants: JiraTransition[] = [
      { ...transition, hasScreen: true, fields: undefined },
      {
        ...transition,
        fields: {
          custom: { name: "Asset", required: true, schema: { type: "any", custom: "asset" } },
        },
      },
      {
        ...transition,
        fields: {
          resolution: { ...transition.fields!.resolution, required: true, operations: ["add"] },
        },
      },
      {
        ...transition,
        fields: {
          resolution: {
            ...transition.fields!.resolution,
            required: true,
            allowedValues: Array.from({ length: 201 }, (_, id) => ({ id: String(id) })),
          },
        },
      },
    ];
    for (const variant of variants) {
      expect(jiraTransition(variant).fields[0]).toMatchObject({
        type: "unsupported",
        required: true,
      });
      expect(jiraTransitionValues(variant)).toHaveProperty("error");
    }
    const optional: JiraTransition = {
      ...transition,
      fields: {
        plugin: { required: false, schema: { type: "string", custom: "other-app:widget" } },
      },
    };
    expect(jiraTransitionValues(optional)).toEqual({});
    expect(jiraTransitionValues(optional, { plugin: "text" })).toHaveProperty("error");
  });
});
