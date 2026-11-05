import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { expect, it } from "@effect/vitest";
import type { ExternalHistoryResponse } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { makeChatGptExportHistory } from "./ChatGptExportHistory.ts";

const conversation = (texts: ReadonlyArray<string>, id = "conversation-1") => ({
  id,
  title: "Exported conversation",
  current_node: `node-${texts.length - 1}`,
  mapping: Object.fromEntries(
    texts.map((text, index) => [
      `node-${index}`,
      {
        parent: index === 0 ? null : `node-${index - 1}`,
        message: {
          id: `message-${index}`,
          author: { role: index % 2 ? "assistant" : "user" },
          content: { parts: [text] },
        },
      },
    ]),
  ),
});
const fixture = Effect.fn("ChatGptExportHistory.test.fixture")(function* (value: unknown) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-external-export-" });
  const filePath = `${directory}/conversations.json`;
  yield* fs.writeFileString(filePath, JSON.stringify(value));
  return { history: yield* makeChatGptExportHistory, fs, filePath };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ChatGPT export history", (it) => {
  it.effect("finds suffix matches and pages digest-verified exact Unicode text", () =>
    Effect.gen(function* () {
      const text = "İ😀" + "a".repeat(3_000) + "NEEDLE [literal]";
      const { history, filePath } = yield* fixture([conversation([text])]);
      const result = yield* history.search(filePath, {
        operation: "search",
        sourceId: "export",
        query: "needle [literal]",
      });
      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]!.excerpt).toContain("NEEDLE [literal]");
      expect(result.matches[0]!.textOffset).toBe(2_803);
      const ref = result.matches[0]!.ref;
      let actual = "";
      let offset: number | null = 0;
      while (offset !== null) {
        const page: Extract<ExternalHistoryResponse, { operation: "read" }> = yield* history.read(
          filePath,
          { operation: "read", ref, textOffset: offset, maxChars: 101 },
        );
        actual += page.text;
        offset = page.nextTextOffset;
      }
      expect(actual).toBe(text);
      const split = yield* history
        .read(filePath, { operation: "read", ref, textOffset: 2 })
        .pipe(Effect.flip);
      expect(split.reason).toBe("invalid_cursor");
      const wrongDigest = yield* history
        .read(filePath, { operation: "read", ref: { ...ref, digest: "0".repeat(64) } })
        .pipe(Effect.flip);
      expect(wrongDigest.reason).toBe("changed");
    }).pipe(Effect.scoped),
  );

  it.effect("continues after empty pages and searches only the selected visible branch", () =>
    Effect.gen(function* () {
      const first = conversation(
        Array.from({ length: 21 }, (_, index) => (index === 20 ? "needle" : "other")),
      );
      const exportValue = [
        {
          ...first,
          mapping: {
            ...first.mapping,
            abandoned: {
              parent: "node-0",
              message: {
                id: "abandoned",
                author: { role: "assistant" },
                content: { parts: ["needle abandoned"] },
              },
            },
            hidden: {
              parent: "node-0",
              message: {
                id: "hidden",
                author: { role: "assistant" },
                content: { parts: ["needle hidden"] },
                metadata: { is_visually_hidden_from_conversation: true },
              },
            },
          },
        },
        conversation(["needle second conversation"], "conversation-2"),
      ];
      const { history, filePath } = yield* fixture(exportValue);
      const request = { operation: "search", sourceId: "export", query: "needle" } as const;
      const page1 = yield* history.search(filePath, request);
      expect(page1.matches).toEqual([]);
      expect(page1.examinedItems).toBe(20);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = yield* history.search(filePath, { ...request, cursor: page1.nextCursor! });
      expect(page2.matches.map((entry) => entry.itemId)).toEqual(["message-20"]);
      const page3 = yield* history.search(filePath, { ...request, cursor: page2.nextCursor! });
      expect(page3.matches.map((entry) => entry.ref.threadId)).toEqual(["conversation-2"]);
      const end = yield* history.search(filePath, { ...request, cursor: page3.nextCursor! });
      expect(end.nextCursor).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("binds search cursors and exact source reads to the current file", () =>
    Effect.gen(function* () {
      const { history, fs, filePath } = yield* fixture([conversation(["needle"])]);
      const request = { operation: "search", sourceId: "export", query: "needle" } as const;
      const page = yield* history.search(filePath, request);
      const wrongQuery = yield* history
        .search(filePath, { ...request, query: "other", cursor: page.nextCursor! })
        .pipe(Effect.flip);
      expect(wrongQuery.reason).toBe("invalid_cursor");
      const wrongSource = yield* history
        .read(filePath, { operation: "read", ref: { ...page.matches[0]!.ref, sourceId: "other" } })
        .pipe(Effect.flip);
      expect(wrongSource.reason).toBe("invalid_cursor");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([conversation(["needle changed source"])]),
      );
      const changed = yield* history
        .read(filePath, { operation: "read", ref: page.matches[0]!.ref })
        .pipe(Effect.flip);
      expect(changed.reason).toBe("changed");
      const stalePage = yield* history
        .search(filePath, { ...request, cursor: page.nextCursor! })
        .pipe(Effect.flip);
      expect(stalePage.reason).toBe("changed");
    }).pipe(Effect.scoped),
  );

  it.effect("drops opaque media before assembly and refuses over-budget visible text", () =>
    Effect.gen(function* () {
      const source = conversation(["needle"]);
      const media = {
        ...source,
        mapping: {
          "node-0": {
            parent: null,
            message: {
              id: "message-0",
              author: { role: "user" },
              content: { parts: ["needle", { image_asset_pointer: "x".repeat(5_000_000) }] },
              metadata: { opaque: "y".repeat(5_000_000) },
            },
          },
        },
      };
      const { history, fs, filePath } = yield* fixture([media]);
      const request = { operation: "search", sourceId: "export", query: "needle" } as const;
      expect((yield* history.search(filePath, request)).matches[0]?.excerpt).toBe("needle");
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([conversation(["x".repeat(5_000_000) + "needle"])]),
      );
      const error = yield* history.search(filePath, request).pipe(Effect.flip);
      expect(error.reason).toBe("limit_exceeded");
    }).pipe(Effect.scoped),
  );

  it.effect("fails explicitly for unsupported exports and ambiguous branches", () =>
    Effect.gen(function* () {
      const { history, fs, filePath } = yield* fixture({ conversations: [] });
      const request = { operation: "search", sourceId: "export", query: "needle" } as const;
      expect((yield* history.search(filePath, request).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
      const source = conversation(["needle"]);
      yield* fs.writeFileString(
        filePath,
        JSON.stringify([
          { ...source, mapping: { "node-0": { ...source.mapping["node-0"], parent: "node-0" } } },
        ]),
      );
      expect((yield* history.search(filePath, request).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
      const duplicate = conversation(["first message", "needle second message"]);
      duplicate.mapping["node-1"]!.message.id = duplicate.mapping["node-0"]!.message.id;
      yield* fs.writeFileString(filePath, JSON.stringify([duplicate]));
      expect((yield* history.search(filePath, request).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
      yield* fs.writeFileString(filePath, '[{"bad":');
      expect((yield* history.search(filePath, request).pipe(Effect.flip)).reason).toBe(
        "unsupported",
      );
    }).pipe(Effect.scoped),
  );
});
