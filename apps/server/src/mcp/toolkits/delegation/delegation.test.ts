import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Tool } from "effect/unstable/ai";

import { providerMcpTools } from "../../providerToolContract.ts";
import {
  AssignToThreadTool,
  DelegateWorkTool,
  DelegateWorkToolInput,
  DelegationToolkit,
  ReportToParentTool,
  SetChildWaitTool,
  SetChildWaitToolInput,
} from "./tools.ts";

const decodeInput = Schema.decodeUnknownSync(DelegateWorkToolInput);
const decodeSetChildWait = Schema.decodeUnknownSync(SetChildWaitToolInput);

const decodeSetChildWaitSucceeds = (input: unknown): boolean => {
  try {
    decodeSetChildWait(input);
    return true;
  } catch {
    return false;
  }
};

interface JsonSchema {
  readonly properties?: unknown;
  readonly required?: ReadonlyArray<string>;
}

const jsonSchema = (tool: Parameters<typeof Tool.getJsonSchema>[0]): JsonSchema =>
  Tool.getJsonSchema(tool) as JsonSchema;

const properties = (schema: JsonSchema): Record<string, unknown> =>
  typeof schema.properties === "object" && schema.properties !== null
    ? (schema.properties as Record<string, unknown>)
    : {};

const assignToThreadProperties = (): ReadonlyArray<string> =>
  Object.keys(properties(jsonSchema(AssignToThreadTool)));

const decodeSucceeds = (input: unknown): boolean => {
  try {
    decodeInput(input);
    return true;
  } catch {
    return false;
  }
};

describe("DelegateWorkToolInput", () => {
  it("accepts a minimal child with only title and prompt", () => {
    expect(
      decodeSucceeds({ children: [{ title: "haiku-check", prompt: "Reply pineapple." }] }),
    ).toBe(true);
  });

  it("rejects a missing children array", () => {
    expect(decodeSucceeds({})).toBe(false);
  });

  it("rejects an empty title or prompt", () => {
    expect(decodeSucceeds({ children: [{ title: "", prompt: "x" }] })).toBe(false);
    expect(decodeSucceeds({ children: [{ title: "x", prompt: "  " }] })).toBe(false);
  });

  it("rejects more than sixteen children", () => {
    const children = Array.from({ length: 17 }, (_, index) => ({
      title: `child-${index}`,
      prompt: "do it",
    }));
    expect(decodeSucceeds({ children })).toBe(false);
  });

  it("rejects an unknown wait policy and out-of-range concurrency", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(decodeSucceeds({ ...base, wait: "eventually" })).toBe(false);
    expect(decodeSucceeds({ ...base, concurrency: 0 })).toBe(false);
    expect(decodeSucceeds({ ...base, concurrency: 5 })).toBe(false);
  });

  it("accepts shared defaults with per-child overrides", () => {
    expect(
      decodeSucceeds({
        defaults: { model: "gpt-6-luna", followUp: "automatic" },
        children: [{ title: "x", prompt: "y", model: "other-model" }],
        wait: "all",
        concurrency: 2,
      }),
    ).toBe(true);
  });

  it("rejects whitespace-only model, project, branch, and path values", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(decodeSucceeds({ ...base, defaults: { model: "  " } })).toBe(false);
    expect(decodeSucceeds({ ...base, defaults: { project: " " } })).toBe(false);
    expect(
      decodeSucceeds({
        children: [
          { title: "x", prompt: "y", workspace: { mode: "isolated", branch: " ", path: "/p" } },
        ],
      }),
    ).toBe(false);
    expect(
      decodeSucceeds({
        children: [
          { title: "x", prompt: "y", workspace: { mode: "isolated", branch: "child", path: "  " } },
        ],
      }),
    ).toBe(false);
  });

  it("rejects unknown, duplicate, and empty prompt template blocks", () => {
    const base = { children: [{ title: "x", prompt: "y" }] };
    expect(
      decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: ["implementation"] } } }),
    ).toBe(true);
    expect(
      decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: ["not-a-block"] } } }),
    ).toBe(false);
    expect(
      decodeSucceeds({
        ...base,
        defaults: { promptTemplate: { blocks: ["commit", "commit"] } },
      }),
    ).toBe(false);
    expect(decodeSucceeds({ ...base, defaults: { promptTemplate: { blocks: [] } } })).toBe(false);
  });

  it("rejects duplicate prompt template evidence entries", () => {
    expect(
      decodeSucceeds({
        children: [{ title: "x", prompt: "y" }],
        defaults: {
          promptTemplate: {
            blocks: ["validation"],
            validation: {
              commands: ["pnpm test"],
              evidence: ["screenshot", "screenshot"],
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("advertises the constrained prompt template contract to strict clients", () => {
    // Strict MCP clients validate the advertised schema; if the enum or the
    // uniqueness constraint were dropped here, only runtime would reject them.
    const advertised = JSON.stringify(Tool.getJsonSchema(DelegateWorkTool));
    expect(advertised).toContain("push-and-create-pr");
    expect(advertised).toContain("uniqueItems");
  });
});

describe("DelegationToolkit cross-thread surface", () => {
  // Regression: a provider reached delegation through this toolkit could
  // create a child but had no tool to message one, so it spawned a second
  // child to deliver a follow-up instead. Creating without messaging is only
  // half a delegation surface.
  const REQUIRED_TOOLS = [
    "assign_to_thread",
    "associate_pull_request",
    "create_isolated_workspace",
    "delegate_work",
    "link_pull_request",
    "list_thread_pull_requests",
    "report_to_parent",
    "send_to_thread",
    "set_child_wait",
    "switch_workspace",
    "unlink_pull_request",
  ] as const;

  it("can both create a child and message one", () => {
    expect(Object.keys(DelegationToolkit.tools).toSorted()).toEqual([...REQUIRED_TOOLS].toSorted());
  });

  it("advertises no duplicate tool names across the provider MCP surface", () => {
    const names = providerMcpTools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("requires the identity fields that make cross-thread calls attributable", () => {
    expect(assignToThreadProperties()).toContain("requestId");
    expect(jsonSchema(AssignToThreadTool).required).toContain("requestId");
    for (const field of ["assignmentId", "dispatchId", "originTurnId"] as const) {
      expect(jsonSchema(ReportToParentTool).required).toContain(field);
    }
  });

  it("keeps set_child_wait restorable when a client strips a null condition", () => {
    // Pi's extension strips null arguments before calling, so a required
    // `condition: null` would arrive absent and fail to decode at runtime.
    const schema = jsonSchema(SetChildWaitTool);
    expect(schema.required ?? []).not.toContain("condition");
    expect(JSON.stringify(properties(schema).condition)).toContain("null");
    expect(decodeSetChildWaitSucceeds({})).toBe(true);
    expect(decodeSetChildWaitSucceeds({ condition: null })).toBe(true);
    expect(
      decodeSetChildWaitSucceeds({
        condition: { mode: "all", assignments: [{ childThreadId: "c", assignmentId: "a" }] },
      }),
    ).toBe(true);
    // `decisions-only` legitimately carries no assignments.
    expect(
      decodeSetChildWaitSucceeds({ condition: { mode: "decisions-only", assignments: [] } }),
    ).toBe(true);
    expect(decodeSetChildWaitSucceeds({ condition: { mode: "whenever", assignments: [] } })).toBe(
      false,
    );
    expect(
      decodeSetChildWaitSucceeds({
        condition: { mode: "all", assignments: [{ childThreadId: "c" }] },
      }),
    ).toBe(false);
  });
});
