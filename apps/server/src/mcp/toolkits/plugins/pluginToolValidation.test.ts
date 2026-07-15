import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  fingerprintPluginTool,
  resolvePluginToolAnnotations,
  validatePluginToolDescriptors,
  validatePluginToolResult,
} from "./pluginToolValidation.ts";
import { pluginToolFinalName } from "./pluginToolNames.ts";

const pluginId = PluginId.make("hello-board");

const baseTool = (
  overrides: Partial<PluginToolDescriptor> & Pick<PluginToolDescriptor, "name">,
): PluginToolDescriptor => ({
  description: "A test tool used by unit tests.",
  inputSchema: Schema.Struct({ value: Schema.String }),
  scope: "read",
  handle: () =>
    Effect.succeed({
      content: [{ type: "text" as const, text: "ok" }],
    }),
  ...overrides,
});

describe("pluginToolNames", () => {
  it("namespaces plugin ids with dashes converted to underscores", () => {
    expect(pluginToolFinalName(pluginId, "echo_note")).toBe("plugin_hello_board__echo_note");
  });
});

describe("validatePluginToolDescriptors", () => {
  it("rejects tools without the tools capability", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(pluginId, [baseTool({ name: "echo" })], {
        hasToolsCapability: false,
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/tools.*capability/);
    }
  });

  // MCP tools/call.arguments is always a string-keyed record. A scalar or union
  // root would be advertised in tools/list but no protocol-valid payload could
  // ever satisfy it, so the tool would be permanently uncallable.
  it("rejects a scalar input schema root", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(
        pluginId,
        [baseTool({ name: "echo", inputSchema: Schema.String })],
        { hasToolsCapability: true },
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/object root/);
    }
  });

  it("rejects a union input schema root", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(
        pluginId,
        [
          baseTool({
            name: "echo",
            inputSchema: Schema.Union([
              Schema.Struct({ a: Schema.String }),
              Schema.Struct({ b: Schema.String }),
            ]),
          }),
        ],
        { hasToolsCapability: true },
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/object root|union/);
    }
  });

  it("accepts a struct input schema root", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(pluginId, [baseTool({ name: "echo" })], {
        hasToolsCapability: true,
      }),
    );
    expect(exit._tag).toBe("Success");
  });

  it("rejects invalid local names", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(pluginId, [baseTool({ name: "Bad-Name" as "bad" })], {
        hasToolsCapability: true,
      }),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/invalid tool name/);
    }
  });

  it("rejects duplicate local names within one plugin", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(
        pluginId,
        [baseTool({ name: "echo" }), baseTool({ name: "echo" })],
        { hasToolsCapability: true },
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/duplicate tool name/);
    }
  });

  it("rejects contradictory read + destructive annotations", () => {
    const exit = Effect.runSyncExit(
      validatePluginToolDescriptors(
        pluginId,
        [baseTool({ name: "echo", scope: "read", destructive: true })],
        { hasToolsCapability: true },
      ),
    );
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toMatch(/contradictory/);
    }
  });

  it("accepts a well-formed tool and fingerprints model-visible metadata", () => {
    const validated = Effect.runSync(
      validatePluginToolDescriptors(
        pluginId,
        [
          baseTool({
            name: "echo_note",
            title: "Echo",
            description: "Echo a short message for the agent.",
          }),
        ],
        { hasToolsCapability: true },
      ),
    );
    expect(validated).toHaveLength(1);
    expect(validated[0]?.finalName).toBe("plugin_hello_board__echo_note");
    expect(validated[0]?.annotations.readOnlyHint).toBe(true);
    expect(validated[0]?.annotations.destructiveHint).toBe(false);
    expect(validated[0]?.fingerprint).toBe(
      fingerprintPluginTool({
        finalName: validated[0]!.finalName,
        description: validated[0]!.description,
        inputJsonSchema: validated[0]!.inputJsonSchema,
        annotations: validated[0]!.annotations,
      }),
    );
  });
});

describe("resolvePluginToolAnnotations", () => {
  it("defaults operate scope to destructive", () => {
    const annotations = resolvePluginToolAnnotations(baseTool({ name: "x", scope: "operate" }));
    expect(annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
  });
});

describe("validatePluginToolResult", () => {
  it("accepts text content and plain JSON structuredContent", () => {
    const result = validatePluginToolResult({
      content: [{ type: "text", text: "hi" }],
      structuredContent: { ok: true },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toEqual([{ type: "text", text: "hi" }]);
      expect(result.value.structuredContent).toEqual({ ok: true });
    }
  });

  it("rejects non-object structuredContent roots", () => {
    const result = validatePluginToolResult({
      content: [{ type: "text", text: "hi" }],
      structuredContent: ["not", "an", "object"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects image content in this slice", () => {
    const result = validatePluginToolResult({
      content: [{ type: "image", data: "abc", mimeType: "image/png" }],
    });
    expect(result.ok).toBe(false);
  });
});
