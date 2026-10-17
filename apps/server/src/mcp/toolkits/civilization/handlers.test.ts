import { describe, expect, it } from "vite-plus/test";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CivilizationToolkit } from "./tools.ts";

const reads = [
  "civilization_context",
  "civilization_census",
  "civilization_note_list",
  "civilization_note_read",
  "civilization_inbox_list",
] as const;

const mutations = [
  "civilization_note_create",
  "civilization_note_update",
  "civilization_note_resolve",
  "civilization_mail_send",
  "civilization_mail_receive",
  "civilization_mail_acknowledge",
] as const;

const jsonSchema = (name: keyof typeof CivilizationToolkit.tools) =>
  Tool.getJsonSchema(CivilizationToolkit.tools[name]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

describe("Civilization MCP toolkit", () => {
  it("marks reads readonly and mutations writable", () => {
    for (const name of reads) {
      expect(Context.get(CivilizationToolkit.tools[name].annotations, Tool.Readonly), name).toBe(
        true,
      );
    }
    for (const name of mutations) {
      expect(Context.get(CivilizationToolkit.tools[name].annotations, Tool.Readonly), name).toBe(
        false,
      );
    }
  });

  it("keeps mutation identity and mode authority off the public schemas", () => {
    const forbidden = [
      "author",
      "authorThreadId",
      "senderThreadId",
      "threadId",
      "projectId",
      "runId",
      "epoch",
      "citizenEpoch",
      "deliveryEpoch",
      "providerInstanceId",
      "runtimeMode",
      "interactionMode",
    ];

    for (const name of mutations) {
      const properties = jsonSchema(name).properties ?? {};
      for (const field of forbidden) {
        expect(properties, `${name} must not expose ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it("requires clientRequestId for civilization_note_create", () => {
    const schema = jsonSchema("civilization_note_create");
    expect(schema.properties).toHaveProperty("clientRequestId");
    expect(schema.required).toContain("clientRequestId");
  });

  it("requires idempotency ids for every Civilization mail mutation", () => {
    for (const name of [
      "civilization_mail_send",
      "civilization_mail_receive",
      "civilization_mail_acknowledge",
    ] as const) {
      const schema = jsonSchema(name);
      expect(schema.properties, name).toHaveProperty("clientRequestId");
      expect(schema.required, name).toContain("clientRequestId");
    }
    expect(jsonSchema("civilization_mail_send").required).toContain("targetThreadId");
    expect(jsonSchema("civilization_mail_receive").required).toContain("messageId");
    expect(jsonSchema("civilization_mail_acknowledge").required).toContain("messageId");
  });

  it("keeps inbox metadata readonly while body offer and acknowledgement are mutations", () => {
    expect(jsonSchema("civilization_inbox_list").properties).not.toHaveProperty("messageId");
    expect(
      Context.get(CivilizationToolkit.tools.civilization_inbox_list.annotations, Tool.Readonly),
    ).toBe(true);
    expect(
      Context.get(CivilizationToolkit.tools.civilization_mail_receive.annotations, Tool.Readonly),
    ).toBe(false);
  });

  it("exposes note-list selection so context packet cursors are followable", () => {
    expect(jsonSchema("civilization_note_list").properties).toHaveProperty("selection");
  });

  it("allows only Civilization read tools in Claude readonly MCP mode", () => {
    const allowed = new Set(ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS);
    const prefix = "mcp__t3-code__";

    for (const name of reads) {
      expect(allowed.has(`${prefix}${name}`), name).toBe(true);
    }
    for (const name of mutations) {
      expect(allowed.has(`${prefix}${name}`), name).toBe(false);
    }

    const civilizationAllowed = [...allowed]
      .filter((name) => name.startsWith(`${prefix}civilization_`))
      .sort();
    expect(civilizationAllowed).toEqual(reads.map((name) => `${prefix}${name}`).sort());
  });
});
