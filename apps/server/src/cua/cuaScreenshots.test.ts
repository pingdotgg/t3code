import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, describe, expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { cuaToolResultOf, saveCuaScreenshot } from "./cuaScreenshots.ts";

const threadId = ThreadId.make("11111111-2222-4333-8444-555555555555");
// A 1x1 PNG.
const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cua-screenshots-"));
afterAll(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }));

const layer = ServerConfig.layerTest(baseDir, baseDir).pipe(Layer.provideMerge(NodeServices.layer));

describe("cuaToolResultOf", () => {
  it("reads the provider-specific result slot", () => {
    expect(cuaToolResultOf({ item: { result: { content: [] } } })).toEqual({ content: [] });
    expect(cuaToolResultOf({ toolName: "x", result: { content: [1] } })).toEqual({ content: [1] });
    expect(cuaToolResultOf({ rawOutput: "text" })).toBe("text");
    expect(cuaToolResultOf({ content: [{ type: "content" }] })).toEqual([{ type: "content" }]);
    expect(cuaToolResultOf("text")).toBeUndefined();
  });
});

describe("saveCuaScreenshot", () => {
  it.effect("writes a Codex MCP image block and keeps the window title", () =>
    Effect.gen(function* () {
      const saved = yield* saveCuaScreenshot({
        threadId,
        result: {
          content: [
            { type: "text", text: "{}" },
            { type: "image", mimeType: "image/png", data: png },
          ],
          structuredContent: { window_title: "December 2026", app_name: "Calendar" },
        },
      });
      expect(saved?.windowTitle).toBe("December 2026");
      expect(saved?.imagePath.endsWith(".png")).toBe(true);
      expect(NodePath.dirname(saved!.imagePath)).toBe(
        NodePath.join(baseDir, "userdata", "browser-artifacts"),
      );
      expect(NodeFS.readFileSync(saved!.imagePath).toString("base64")).toBe(png);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads a Claude tool_result block and an ACP content list", () =>
    Effect.gen(function* () {
      const claude = yield* saveCuaScreenshot({
        threadId,
        result: {
          type: "tool_result",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } },
          ],
        },
      });
      expect(claude?.imagePath.endsWith(".jpg")).toBe(true);
      const acp = yield* saveCuaScreenshot({
        threadId,
        result: [{ type: "content", content: { type: "image", data: png, mimeType: "image/png" } }],
      });
      expect(acp?.imagePath.endsWith(".png")).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("ignores results without an image", () =>
    Effect.gen(function* () {
      expect(
        yield* saveCuaScreenshot({
          threadId,
          result: { content: [{ type: "text", text: "clicked" }] },
        }),
      ).toBeUndefined();
      expect(yield* saveCuaScreenshot({ threadId, result: "plain text" })).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );
});
