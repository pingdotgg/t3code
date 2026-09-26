import { expect, it } from "@effect/vitest";
import * as NodeBuffer from "node:buffer";
import { catalogPage } from "./catalog.ts";
const tool = (id: string) => ({
  installationId: "fixture.catalog",
  contentHash: "a".repeat(64),
  descriptor: {
    id,
    title: "Fixture",
    description: "🌈".repeat(1000),
    inputSchema: { type: "object" },
    readOnly: true as const,
    capabilities: [],
  },
});
it("pages all descriptors without omissions and bounds the entire serialized result", () => {
  const tools = Array.from({ length: 32 * 16 }, (_, index) =>
    tool("fixture.catalog/tool-" + index.toString().padStart(4, "0")),
  ).toReversed();
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let index = 0; index < tools.length; index++) {
    const page = catalogPage(tools, cursor);
    expect(NodeBuffer.Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(65536);
    expect(page.tools.length).toBeGreaterThan(0);
    seen.push(...page.tools.map((tool) => tool.descriptor.id));
    expect(page.tools.every((tool) => tool.contentHash === "a".repeat(64))).toBe(true);
    if (page.nextCursor === null) break;
    expect(cursor === undefined || page.nextCursor > cursor).toBe(true);
    cursor = page.nextCursor;
  }
  expect(seen).toEqual(tools.map((tool) => tool.descriptor.id).sort());
  expect(new Set(seen).size).toBe(tools.length);
});
it("does not silently skip an oversized first descriptor or invent an empty-page cursor", () => {
  expect(() =>
    catalogPage([
      {
        ...tool("fixture.catalog/large"),
        descriptor: { ...tool("fixture.catalog/large").descriptor, description: "x".repeat(65536) },
      },
    ]),
  ).toThrow("exceeds");
  expect(catalogPage([])).toEqual({ tools: [], nextCursor: null });
  expect(catalogPage([tool("fixture.catalog/a")], "fixture.catalog/a")).toEqual({
    tools: [],
    nextCursor: null,
  });
});
