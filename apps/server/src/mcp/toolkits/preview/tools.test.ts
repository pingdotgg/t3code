import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";
import { PreviewAutomationNetworkEntry } from "@t3tools/contracts";

import { PreviewToolkit } from "./tools.ts";

const schemaHasMultipleAllOfDescriptions = (schema: unknown): boolean => {
  if (!schema || typeof schema !== "object") return false;
  const record = schema as Record<string, unknown>;
  const allOf = Array.isArray(record.allOf) ? record.allOf : [];
  const descriptionCount = allOf.filter(
    (member) =>
      member !== null &&
      typeof member === "object" &&
      typeof (member as Record<string, unknown>).description === "string",
  ).length;
  return descriptionCount > 1 || Object.values(record).some(schemaHasMultipleAllOfDescriptions);
};

it("exports provider-compatible object schemas", () => {
  for (const tool of Object.values(PreviewToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf, `${tool.name} must not export a root anyOf`).toBeUndefined();
    expect(schema.oneOf, `${tool.name} must not export a root oneOf`).toBeUndefined();
    if (tool.name === "preview_navigate") {
      expect(schemaHasMultipleAllOfDescriptions(schema)).toBe(false);
    }
    if (tool.name.startsWith("preview_profile_")) {
      expect(schema.properties?.tabId, `${tool.name} is not tab-targeted`).toBeUndefined();
    } else {
      expect(
        schema.properties?.tabId,
        `${tool.name} must allow an explicit collaborative browser tab target`,
      ).toBeDefined();
    }
  }
});

it("preview_open accepts a target while preserving open input constraints", () => {
  const decode = Schema.decodeUnknownSync(PreviewToolkit.tools.preview_open.parametersSchema);
  const target = { kind: "environment-port", port: 3000 };
  expect(decode({ target })).toEqual({ target });
  expect(decode({})).toEqual({});
  expect(decode({ url: "https://example.com" })).toEqual({ url: "https://example.com" });
  expect(decode({ url: "http://localhost:3000", target })).toEqual({
    url: "http://localhost:3000",
    target,
  });
  expect(() => decode({ target: { ...target, port: 0 } })).toThrow();
  expect(() => decode({ target, tabId: "tab-1", reuseExistingTab: false })).toThrow();
});

it("exports the expanded browser tool surface with compatible schemas", () => {
  expect(Object.keys(PreviewToolkit.tools)).toEqual(
    expect.arrayContaining([
      "preview_profile_create",
      "preview_profile_rename",
      "preview_profile_delete",
      "preview_history",
      "preview_downloads",
      "preview_console_logs",
      "preview_network_logs",
      "preview_workflow_start",
      "preview_workflow_stop",
    ]),
  );

  const decodeOpen = Schema.decodeUnknownSync(PreviewToolkit.tools.preview_open.parametersSchema);
  expect(decodeOpen({ ephemeral: true })).toEqual({ ephemeral: true });
  expect(decodeOpen({ ephemeral: true, profileId: "incognito" })).toEqual({
    ephemeral: true,
    profileId: "incognito",
  });
  expect(() => decodeOpen({ ephemeral: true, profileId: "default" })).toThrow();

  const decodeHistory = Schema.decodeUnknownSync(
    PreviewToolkit.tools.preview_history.parametersSchema,
  );
  expect(decodeHistory({ action: "reload", hardReload: true, readiness: "none" })).toEqual({
    action: "reload",
    hardReload: true,
    readiness: "none",
  });
  expect(() => decodeHistory({ action: "home" })).toThrow();
});

it("keeps existing network entries valid while new inspection fields stay optional", () => {
  const decode = Schema.decodeUnknownSync(PreviewAutomationNetworkEntry);
  expect(
    decode({
      url: "https://example.com",
      method: "GET",
      status: 200,
      failed: false,
      timestamp: "2026-01-01T00:00:00.000Z",
    }),
  ).toEqual({
    url: "https://example.com",
    method: "GET",
    status: 200,
    failed: false,
    timestamp: "2026-01-01T00:00:00.000Z",
  });
});
