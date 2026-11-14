// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";
import { extractDocumentText } from "./documentTextWorker.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as NodeZlib from "node:zlib";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";

vi.mock("node:child_process", { spy: true });

import { layer, attachment } from "./userInputAttachments-fixtures.testkit.ts";
import { documentExtractionCases } from "./userInputAttachments-02-fixtures.testkit.ts";
describe("question answer paths", () => {
  it.effect("preserves office structure and EPUB reading order with bounded archives", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cases = documentExtractionCases;
      for (const [caseIndex, item] of cases.entries()) {
        const local: Buffer[] = [];
        const central: Buffer[] = [];
        let offset = 0;
        for (const [name, content] of Object.entries(item.parts)) {
          const data = Buffer.from(content!);
          const compressed = /\.(bmp|bin)$/.test(name) ? NodeZlib.deflateRawSync(data) : data;
          const filename = Buffer.from(name);
          const header = Buffer.alloc(30);
          header.writeUInt32LE(0x04034b50);
          header.writeUInt16LE(20, 4);
          header.writeUInt16LE(compressed === data ? 0 : 8, 8);
          header.writeUInt32LE(NodeZlib.crc32(data), 14);
          header.writeUInt32LE(compressed.length, 18);
          header.writeUInt32LE(data.length, 22);
          header.writeUInt16LE(filename.length, 26);
          const directory = Buffer.alloc(46);
          directory.writeUInt32LE(0x02014b50);
          directory.writeUInt16LE(20, 4);
          directory.writeUInt16LE(20, 6);
          directory.writeUInt16LE(compressed === data ? 0 : 8, 10);
          directory.writeUInt32LE(NodeZlib.crc32(data), 16);
          directory.writeUInt32LE(compressed.length, 20);
          directory.writeUInt32LE(data.length, 24);
          directory.writeUInt16LE(filename.length, 28);
          directory.writeUInt32LE(offset, 42);
          local.push(header, filename, compressed);
          central.push(directory, filename);
          offset += header.length + filename.length + compressed.length;
        }
        const end = Buffer.alloc(22);
        end.writeUInt32LE(0x06054b50);
        end.writeUInt16LE(central.length / 2, 8);
        end.writeUInt16LE(central.length / 2, 10);
        end.writeUInt32LE(Buffer.concat(central).length, 12);
        end.writeUInt32LE(offset, 16);
        const path = NodePath.join(config.attachmentsDir, `structure-${caseIndex}.${item.ext}`);
        NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
        const extracted = yield* Effect.promise(() => extractDocumentText(path, `.${item.ext}`));
        let previous = -1;
        for (const expected of item.expected) {
          const index = extracted.indexOf(expected);
          expect(index, `${item.ext}: ${expected} in ${extracted.slice(0, 500)}`).toBeGreaterThan(
            previous,
          );
          previous = index;
        }
        if ("occurrences" in item)
          expect(extracted.split(item.occurrences.text).length - 1).toBe(item.occurrences.count);
        if ("absent" in item)
          for (const absent of item.absent) expect(extracted).not.toContain(absent);
        if (("bounded" in item && item.bounded) || item.ext === "epub") {
          expect(extracted.length).toBeLessThan(1_000_100);
          expect(extracted.match(/\[Extracted text truncated/g)?.length ?? 0).toBeLessThanOrEqual(
            1,
          );
          const documents = yield* DocumentText.DocumentText;
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(extracted);
        }
        if (item.ext === "docx") {
          end.writeUInt16LE(2049, 8);
          end.writeUInt16LE(2049, 10);
          NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
          yield* Effect.promise(async () => {
            expect(await extractDocumentText(path, ".docx")).toContain("[Extracted text truncated");
          });
          end.writeUInt16LE(central.length / 2, 8);
          end.writeUInt16LE(central.length / 2, 10);
          central[0]!.writeUInt16LE(8, 10);
          central[0]!.writeUInt32LE(33 * 1024 * 1024, 24);
          NodeFS.writeFileSync(path, Buffer.concat([...local, ...central, end]));
          yield* Effect.promise(async () => {
            expect(await extractDocumentText(path, ".docx")).toContain("[Extracted text truncated");
          });
        }
      }
      const path = NodePath.join(config.attachmentsDir, "unicode.rtf");
      NodeFS.writeFileSync(
        path,
        String.raw`{\rtf1\ansi{\fonttbl hidden}Hello\tab world\par Unicode \u945?{\*\secret hidden}}`,
      );
      const extracted = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(extracted).toContain("Hello\tworld\nUnicode α");
      expect(extracted).not.toContain("hidden");

      for (const [name, content, expected] of [
        [
          "cyrillic-escaped",
          String.raw`{\rtf1\ansi\ansicpg1251 \'cf\'f0\'e8\'e2\'e5\'f2 {\ansicpg1252 \'e9} \'cc\'ee\'f1\'ea\'e2\'e0}`,
          "Привет é Москва",
        ],
        [
          "cyrillic-raw",
          Buffer.concat([
            Buffer.from(String.raw`{\rtf1\ansi\ansicpg1251 `),
            Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]),
            Buffer.from("}"),
          ]),
          "Привет",
        ],
      ] as const) {
        const encodedPath = NodePath.join(config.attachmentsDir, `${name}.rtf`);
        NodeFS.writeFileSync(encodedPath, content);
        expect(yield* Effect.promise(() => extractDocumentText(encodedPath, ".rtf"))).toBe(
          expected,
        );
        const documents = yield* DocumentText.DocumentText;
        expect(yield* documents.ensure(encodedPath)).toBe(encodedPath + ".txt");
        expect(NodeFS.readFileSync(encodedPath + ".txt", "utf8")).toBe(expected);
      }
      const notebookPath = NodePath.join(config.attachmentsDir, "limited.ipynb");
      NodeFS.writeFileSync(
        notebookPath,
        JSON.stringify({ cells: Array.from({ length: 10_001 }, () => ({ source: "Kept" })) }),
      );
      const notebookLimited = yield* Effect.promise(() =>
        extractDocumentText(notebookPath, ".ipynb"),
      );
      expect(notebookLimited).toContain("## Cell 10000");
      expect(notebookLimited).not.toContain("## Cell 10001");
      expect(notebookLimited.match(/\[Extracted text truncated/g)).toHaveLength(1);
      expect(yield* (yield* DocumentText.DocumentText).ensure(notebookPath)).toBe(
        notebookPath + ".txt",
      );
      expect(NodeFS.readFileSync(notebookPath + ".txt", "utf8")).toBe(notebookLimited);
      const errorPath = NodePath.join(config.attachmentsDir, "limited-error.ipynb");
      NodeFS.writeFileSync(
        errorPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: "1 / 0",
              outputs: [
                {
                  output_type: "error",
                  ename: "ZeroDivisionError",
                  evalue: "division by zero",
                  traceback: ["\u001b[31m" + "trace".repeat(250_000) + "\u001b[0m", "After limit"],
                },
              ],
            },
          ],
        }),
      );
      const errorLimited = yield* Effect.promise(() => extractDocumentText(errorPath, ".ipynb"));
      expect(errorLimited).toContain("ZeroDivisionError: division by zero\ntrace");
      expect(errorLimited.length).toBeLessThan(1_000_100);
      expect(errorLimited.match(/\[Extracted text truncated/g)).toHaveLength(1);
      expect(errorLimited).not.toContain("After limit");
      expect(errorLimited).not.toContain("\u001b");
      const deepPath = NodePath.join(config.attachmentsDir, "deep.rtf");
      NodeFS.writeFileSync(
        deepPath,
        String.raw`{\rtf1 Kept` + "{".repeat(128) + "Lost" + "}".repeat(129),
      );
      const deepLimited = yield* Effect.promise(() => extractDocumentText(deepPath, ".rtf"));
      expect(deepLimited).toBe("Kept\n\n[Extracted text truncated at document extraction limits.]");
      const unsupportedPath = NodePath.join(config.attachmentsDir, "unsupported-codepage.rtf");
      NodeFS.writeFileSync(unsupportedPath, String.raw`{\rtf1\ansi\ansicpg932 \'82\'a0}`);
      yield* Effect.promise(async () => {
        await expect(extractDocumentText(unsupportedPath, ".rtf")).rejects.toThrow(
          "Unsupported RTF code page",
        );
      });
      expect(yield* (yield* DocumentText.DocumentText).ensure(unsupportedPath)).toBeUndefined();
      expect(NodeFS.existsSync(unsupportedPath + ".txt")).toBe(false);
      NodeFS.writeFileSync(path, String.raw`{\rtf1 ` + "x".repeat(1_000_100) + "}");
      expect(yield* Effect.promise(() => extractDocumentText(path, ".rtf"))).toContain(
        "[Extracted text truncated",
      );
      NodeFS.writeFileSync(path, String.raw`{\rtf1 First` + " ".repeat(1_000_100) + "Last}");
      const whitespaceTruncated = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(whitespaceTruncated).toBe(
        "First\n\n[Extracted text truncated at document extraction limits.]",
      );
      const documents = yield* DocumentText.DocumentText;
      expect(yield* documents.ensure(path)).toBe(path + ".txt");
      expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(whitespaceTruncated);
      NodeFS.truncateSync(path, 17 * 1024 * 1024);
      yield* Effect.promise(async () => {
        expect(await extractDocumentText(path, ".rtf")).toContain("[Extracted text truncated");
      });
    }).pipe(Effect.provide(layer)),
  );







});
