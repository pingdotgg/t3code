import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { snapshotMcpApp } from "./McpAppSnapshot.ts";

describe("MCP App snapshot", () => {
  it.effect("prefers the exact requested URI regardless of response order", () =>
    Effect.gen(function* () {
      const uri = "ui://example/dashboard.html";
      const token = Buffer.from(JSON.stringify({ v: 1, serverId: "example", uri })).toString(
        "base64url",
      );
      const requested = `${uri}?__cf_mcp_server_id=${token}`;
      const fallback = {
        uri,
        mimeType: "text/html;profile=mcp-app",
        text: "<html>fallback</html>",
      };
      const exact = {
        uri: requested,
        mimeType: "text/html;profile=mcp-app",
        text: "<html>exact</html>",
      };
      for (const contents of [
        [fallback, exact],
        [exact, fallback],
      ]) {
        let writtenHtml = "";
        yield* snapshotMcpApp({
          attachmentsDir: "/tmp/attachments",
          threadId: ThreadId.make("thread-test"),
          server: "gateway",
          tool: "preview",
          resourceUri: requested,
          contents,
        }).pipe(
          Effect.provide(
            FileSystem.layerNoop({
              writeFileString: (_path, html) =>
                Effect.sync(() => {
                  writtenHtml = html;
                }),
            }),
          ),
        );
        expect(writtenHtml).toContain("exact");
        expect(writtenHtml).not.toContain("fallback");
      }
    }),
  );
  it.effect("captures a portal resource returned with its original URI", () =>
    Effect.gen(function* () {
      const uri = "ui://example/dashboard.html";
      const token = Buffer.from(JSON.stringify({ v: 1, serverId: "example", uri })).toString(
        "base64url",
      );
      const requested = `${uri}?__cf_mcp_server_id=${token}`;
      let writtenHtml = "";
      const result = yield* snapshotMcpApp({
        attachmentsDir: "/tmp/attachments",
        threadId: ThreadId.make("thread-test"),
        server: "gateway",
        tool: "preview",
        resourceUri: requested,
        contents: [
          {
            uri: "ui://example/other.html",
            mimeType: "text/html;profile=mcp-app",
            text: "<html>decoy</html>",
          },
          { uri, mimeType: "text/html;profile=mcp-app", text: "<html>preview</html>" },
        ],
      }).pipe(
        Effect.provide(
          FileSystem.layerNoop({
            writeFileString: (_path, html) =>
              Effect.sync(() => {
                writtenHtml = html;
              }),
          }),
        ),
      );
      expect(result?.resourceUri).toBe(requested);
      expect(writtenHtml).toContain("preview");
      expect(writtenHtml).not.toContain("decoy");
    }),
  );
});
