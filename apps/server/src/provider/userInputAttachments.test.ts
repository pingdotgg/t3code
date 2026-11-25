// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "./DocumentText.ts";
import { extractDocumentText } from "./documentTextWorker.ts";
import * as Cleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as NodeZlib from "node:zlib";
import { appendUserInputAttachmentPaths } from "./userInputAttachments.ts";

vi.mock("node:child_process", { spy: true });

const layer = Layer.merge(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-answer-paths-" }),
  DocumentText.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  name: 'spec "final".txt',
  mimeType: "text/plain",
  sizeBytes: 4,
};
describe("question answer paths", () => {
  it.effect.each([false, true])(
    "keeps unrelated files available during extraction (failure: %s)",
    (failure) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = NodePath.join(config.attachmentsDir, "blocked.rtf");
        const cached = NodePath.join(config.attachmentsDir, "cached.rtf");
        NodeFS.writeFileSync(path, failure ? "invalid document" : String.raw`{\rtf1 Available}`);
        NodeFS.writeFileSync(cached + ".txt", "Cached text");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let reads = 0;
        yield* Effect.gen(function* () {
          const documents = yield* DocumentText.DocumentText;
          const extraction = yield* documents.ensure(path).pipe(Effect.forkChild);
          yield* Deferred.await(started);
          const duplicate = yield* documents.ensure(path).pipe(Effect.forkChild);
          expect(yield* documents.ensure(path + ".png")).toBeUndefined();
          expect(yield* documents.ensure(path + ".pdf")).toBeUndefined();
          expect(yield* documents.ensure(cached)).toBe(cached + ".txt");
          expect(NodeFS.readFileSync(cached + ".txt", "utf8")).toBe("Cached text");
          yield* Deferred.succeed(release, undefined);
          const expected = failure ? undefined : path + ".txt";
          expect(yield* Fiber.join(extraction)).toBe(expected);
          expect(yield* Fiber.join(duplicate)).toBe(expected);
          expect(yield* documents.ensure(path)).toBe(expected);
          expect(reads).toBe(1);
          if (failure) {
            NodeFS.writeFileSync(path + ".txt", "Recovered text");
            expect(yield* documents.ensure(path)).toBe(path + ".txt");
            expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Recovered text");
          } else expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
        }).pipe(
          Effect.provide(Layer.fresh(DocumentText.layer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            stat: (file) =>
              file === path
                ? Effect.gen(function* () {
                    reads++;
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    return yield* fs.stat(file);
                  })
                : fs.stat(file),
          }),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["interrupted", "failed"])(
    "extracts two documents at once and frees a slot when one is %s",
    (outcome) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const [first, second, third] = ["first", "second", "third"].map((name) =>
          NodePath.join(config.attachmentsDir, `${name}.rtf`),
        );
        NodeFS.writeFileSync(first!, String.raw`{\rtf1 First}`);
        NodeFS.writeFileSync(second!, "invalid document");
        NodeFS.writeFileSync(third!, String.raw`{\rtf1 Third}`);
        const started = yield* Queue.unbounded<string>();
        const releases = new Map<string, Deferred.Deferred<void>>();
        for (const path of [first!, second!, third!])
          releases.set(path, yield* Deferred.make<void>());
        yield* Effect.gen(function* () {
          const documents = yield* DocumentText.DocumentText;
          const leaving = yield* documents.ensure(first!).pipe(Effect.forkChild);
          const staying = yield* documents.ensure(first!).pipe(Effect.forkChild);
          const freed = yield* documents.ensure(second!).pipe(Effect.forkChild);
          expect(new Set([yield* Queue.take(started), yield* Queue.take(started)])).toEqual(
            new Set([first, second]),
          );
          const waiting = yield* documents.ensure(third!).pipe(Effect.forkChild);
          yield* Fiber.interrupt(leaving);
          if (outcome === "interrupted") yield* Fiber.interrupt(freed);
          else {
            yield* Deferred.succeed(releases.get(second!)!, undefined);
            expect(yield* Fiber.join(freed)).toBeUndefined();
          }
          expect(yield* Queue.take(started)).toBe(third);
          yield* Deferred.succeed(releases.get(first!)!, undefined);
          yield* Deferred.succeed(releases.get(third!)!, undefined);
          expect(yield* Fiber.join(staying)).toBe(first + ".txt");
          expect(yield* Fiber.join(waiting)).toBe(third + ".txt");
          expect(yield* Queue.size(started)).toBe(0);
          expect(NodeFS.existsSync(second + ".txt")).toBe(false);
          expect(
            NodeFS.readdirSync(config.attachmentsDir).filter((file) => file.endsWith(".part")),
          ).toEqual([]);
        }).pipe(
          Effect.provide(Layer.fresh(DocumentText.layer)),
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            // An async probe can let `staying` join only after `leaving` cancelled the lookup.
            exists: (file) => Effect.sync(() => NodeFS.existsSync(file)),
            stat: (file) =>
              Effect.gen(function* () {
                yield* Queue.offer(started, file);
                yield* Deferred.await(releases.get(file)!);
                return yield* fs.stat(file);
              }),
          }),
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("retries a document while its cancelled extraction is still publishing", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = NodePath.join(config.attachmentsDir, "retried.rtf");
      NodeFS.writeFileSync(path, String.raw`{\rtf1 Retried}`);
      const writing = yield* Deferred.make<void>();
      const writeReleased = yield* Deferred.make<void>();
      const renaming = yield* Deferred.make<void>();
      const renameReleased = yield* Deferred.make<void>();
      let writes = 0;
      let renames = 0;
      yield* Effect.gen(function* () {
        const documents = yield* DocumentText.DocumentText;
        const cancelled = yield* documents.ensure(path).pipe(Effect.forkChild);
        yield* Deferred.await(writing);
        const interrupting = yield* Fiber.interrupt(cancelled).pipe(Effect.forkChild);
        const retry = yield* documents.ensure(path).pipe(Effect.forkChild);
        yield* Deferred.await(renaming);
        yield* Deferred.succeed(writeReleased, undefined);
        yield* Fiber.join(interrupting);
        yield* Deferred.succeed(renameReleased, undefined);
        expect(yield* Fiber.join(retry)).toBe(path + ".txt");
        expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Retried");
        expect(
          NodeFS.readdirSync(config.attachmentsDir).filter((file) => file.endsWith(".part")),
        ).toEqual([]);
      }).pipe(
        Effect.provide(Layer.fresh(DocumentText.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, data) =>
            Effect.gen(function* () {
              if (++writes === 1) {
                yield* Deferred.succeed(writing, undefined);
                yield* Deferred.await(writeReleased);
              }
              return yield* fs.writeFileString(file, data);
            }),
          rename: (from, to) =>
            Effect.gen(function* () {
              if (++renames === 1) {
                yield* Deferred.succeed(renaming, undefined);
                yield* Deferred.await(renameReleased);
              }
              return yield* fs.rename(from, to);
            }),
        }),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each(["spawn", "read"])("retries after a transient %s failure expires", (failure) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const { execFile } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
        const worker = vi.spyOn(NodeChildProcess, "execFile");
        worker.mockImplementationOnce(((
          file: string,
          args: readonly string[],
          options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
          callback: (
            error: NodeChildProcess.ExecFileException | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) => {
          if (failure === "spawn") {
            throw Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" });
          }
          const preload = `import fs from 'node:fs/promises';
            import { syncBuiltinESMExports } from 'node:module';
            fs.readFile = async () => { throw Object.assign(new Error('read EAGAIN'), { code: 'EAGAIN' }); };
            syncBuiltinESMExports();`;
          return execFile(
            file,
            ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, ...args],
            options,
            callback,
          );
        }) as typeof NodeChildProcess.execFile);
        return worker;
      }),
      (worker) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, "retry.rtf");
          NodeFS.writeFileSync(path, String.raw`{\rtf1 Available}`);
          const documents = yield* DocumentText.DocumentText;
          expect(yield* documents.ensure(path)).toBeUndefined();
          expect(yield* documents.ensure(path)).toBeUndefined();
          expect(worker).toHaveBeenCalledTimes(1);
          expect(NodeFS.existsSync(path + ".txt")).toBe(false);
          yield* TestClock.adjust("1 second");
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
          expect(worker).toHaveBeenCalledTimes(2);
          expect(yield* documents.ensure(path)).toBe(path + ".txt");
          expect(worker).toHaveBeenCalledTimes(2);
        }).pipe(Effect.provide(layer)),
      (worker) => Effect.sync(() => worker.mockRestore()),
    ),
  );

  it.effect.each([
    ["ipynb", "{"],
    ["rtf", "invalid document"],
    ["rtf", String.raw`{\rtf1}`],
    ["rtf", String.raw`{\rtf1\ansi\ansicpg99999 Unsupported}`],
  ] as const)("caches unchanged document rejections: %s %s", ([extension, source]) =>
    Effect.acquireUseRelease(
      Effect.sync(() => vi.spyOn(NodeChildProcess, "execFile")),
      (worker) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, `invalid.${extension}`);
          NodeFS.writeFileSync(path, source);
          const documents = yield* DocumentText.DocumentText;
          for (const seconds of [0, 1, 60]) {
            yield* TestClock.adjust(`${seconds} seconds`);
            expect(yield* documents.ensure(path)).toBeUndefined();
            expect(worker).toHaveBeenCalledTimes(1);
            expect(NodeFS.existsSync(path + ".txt")).toBe(false);
          }
        }).pipe(Effect.provide(layer)),
      (worker) => Effect.sync(() => worker.mockRestore()),
    ),
  );

  it.effect.each([
    [
      "page-specific headers and footers",
      String.raw`{\rtf1\ansi\facingp\sectd\titlepg
{\headerf First-page header}{\headerl Left-page header}{\headerr Right-page header}
{\footerf First-page footer}{\footerl Left-page footer}{\footerr Right-page footer}
\pard Approved delivery date: 24 November.\par
}`,
      "Approved delivery date: 24 November.",
    ],
    [
      "text symbols",
      String.raw`{\rtf1\ansi Pages 1\endash 5\emdash\lquote left\rquote\ldblquote right\rdblquote\bullet\b End\b0\unknown{\*\secret\bullet hidden}}`,
      "Pages 1–5—‘left’“right”•End",
    ],
    [
      "space and hyphen symbols",
      String.raw`{\rtf1\ansi A\enspace B\emspace C\qmspace D\~E\_F\-G}`,
      "A\u2002B\u2003C\u2005D\u00a0E\u2011FG",
    ],
    [
      "joiner and direction marks",
      String.raw`{\rtf1\ansi A\zwj B\zwnj C\ltrmark D\rtlmark E}`,
      "A\u200dB\u200cC\u200eD\u200fE",
    ],
    [
      "text symbol fallback",
      String.raw`{\rtf1\ansi\uc10\u945\endash\emdash\enspace\emspace\qmspace\lquote\rquote\ldblquote\rdblquote\bullet Z}`,
      "αZ",
    ],
    ["hyphen symbol fallback", String.raw`{\rtf1\ansi\uc3\u945\~\_\-Z}`, "αZ"],
    ["control word", String.raw`{\rtf1\ansi A\u9\tab X}`, "A\tX"],
    ["line break paragraphs", "{\\rtf1\\ansi First\\\nSecond\\\r\nThird}", "First\nSecond\nThird"],
    [
      "tracked deletion",
      String.raw`{\rtf1\ansi The fee is {\deleted\revauthdel1\revdttmdel1 $500}{\revised\revauth1 $700}.}`,
      "The fee is $700.",
    ],
    [
      "tracked deletion end",
      String.raw`{\rtf1\ansi{\header Header\plain Plain}A\deleted B\deleted0 C\deleted D\plain E}`,
      "ACE",
    ],
    [
      "tracked deletion fallback",
      String.raw`{\rtf1\ansi A{\deleted\uc1\u945\deleted0 B}\deleted\u946?\deleted0 C}`,
      "AC",
    ],
    [
      "tracked deletion table",
      String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\deleted\cell\deleted0 B\cell\deleted\row\deleted0 C\cell}`,
      "A\tB\t\nC",
    ],
    [
      "hidden text",
      String.raw`{\rtf1\ansi A {\v B{\v0 C}D} E\v F\v0  G\v1 H\plain  I}`,
      "A C E G I",
    ],
    [
      "hidden text table and escapes",
      String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000\intbl A\v B\u945?\'e9\cell\v0 C\cell\v\row\v0 D\cell}`,
      "A\tC\t\nD",
    ],
    [
      "document breaks",
      String.raw`{\rtf1\ansi\sectd\cols2\pard North quota: 120\column South quota: 240\page East quota: 360\sect\sectd\pard West quota: 480\par}`,
      "North quota: 120\nSouth quota: 240\nEast quota: 360\nWest quota: 480",
    ],
    ["group close", String.raw`{\rtf1\ansi{\u945}Z}`, "αZ"],
    ["group open", String.raw`{\rtf1\ansi\u945{Z}}`, "αZ"],
    ["hex byte", String.raw`{\rtf1\ansi\u945\'3fZ}`, "αZ"],
    ["escaped symbol", String.raw`{\rtf1\ansi\u945\{Z}`, "αZ"],
    ["Macintosh text", String.raw`{\rtf1\mac Caf\'8e Cr\'8fme}`, "Café Crème"],
    [
      "explicit Macintosh code page",
      String.raw`{\rtf1\mac\ansicpg10000 Caf\'8e Cr\'8fme}`,
      "Café Crème",
    ],
    ["default ANSI code page", String.raw`{\rtf1\ansi\ansicpg0 Caf\'e9}`, "Café"],
    [
      "DOS Cyrillic code page",
      String.raw`{\rtf1\ansi\ansicpg866 \'8f\'e0\'a8\'a2\'a5\'e2}`,
      "Привет",
    ],
    [
      "UTF-8 code page",
      String.raw`{\rtf1\ansi\ansicpg65001 \'e4\'bd\'a0\'e5\'a5\'bd \'f0\'9f\'9a\'80}`,
      "你好 🚀",
    ],
    [
      "Shift_JIS code page",
      "{\\rtf1\\ansi\\ansicpg932 \\'82\\'a0\\'82\\'a2\\'83\\\\\\'81@X}",
      "あいソ\u3000X",
    ],
    [
      "GBK code page with line-wrapped hex bytes",
      "{\\rtf1\\ansi\\ansicpg936 \\'c4\n\\'e3\\'ba\\'c3}",
      "你好",
    ],
    [
      "GB18030 code page",
      String.raw`{\rtf1\ansi\ansicpg54936 \'d6\'d0\'ce\'c4 \'95\'32\'82\'36}`,
      "中文 𠀀",
    ],
    ["Big5 code page", String.raw`{\rtf1\ansi\ansicpg950 \'a7A\'a6n}`, "你好"],
    [
      "multibyte font charsets and font code pages",
      String.raw`{\rtf1\ansi\ansicpg1252{\fonttbl{\f0\fcharset128 Mincho;}{\f1\fcharset134 SimSun;}{\f2\fcharset129 Gulim;}{\f3\fcharset136 MingLiU;}{\f4\cpg65001 Noto;}{\f5\fcharset255 Terminal;}{\f6\fcharset1 Default;}}\f0\'82\'a0\f1\'c4\'e3\f2\'be\'c8\f3\'a7\'41\f4\'e2\'9c\'93\f5\'8f\f6\'e9}`,
      "あ你안你✓Пé",
    ],
    [
      "multibyte unicode fallbacks",
      String.raw`{\rtf1\ansi\ansicpg936\uc2\u20320\'c4\'e3\'ba\'c3}`,
      "你好",
    ],
    [
      "font character set",
      String.raw`{\rtf1\ansi\ansicpg1252\deff1{\fonttbl\f0\fnil\fcharset178 GeezaPro;\f1\fnil\fcharset0 LucidaGrande;}
\f0 \'e3\'e1\'c7\'cd\'d9\'c9\f1 : caf\'e9, \f0\plain\'c7a}`,
      "ملاحظة: café, Ça",
    ],
    [
      "ANSI font under another code page",
      String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl\f0\froman\fcharset0 Times-Roman;}\f0 \'805 caf\'e9}`,
      "€5 café",
    ],
    [
      "font code page",
      String.raw`{\rtf1\ansi\ansicpg1251{\fonttbl{\f0\fnil\fcharset0\cpg1251 Arial;}{\f1\fnil\fcharset204 Arial{\*\fontfile\cpg1252 arial.ttf};}}\f0 \'cf\'f0\'e8\f1\'e2\'e5\'f2}`,
      "Привет",
    ],
    [
      "ANSI font in a Macintosh document",
      String.raw`{\rtf1\mac\ansicpg10000{\fonttbl\f0\fnil\fcharset0 LucidaGrande;}\f0 pridr\'9eana}`,
      "pridržana",
    ],
    [
      "Macintosh font code page",
      String.raw`{\rtf1\mac\ansicpg10000{\fonttbl\f0\fnil\fcharset0\cpg10000 Geneva;}\f0 Caf\'8e}`,
      "Café",
    ],
    [
      "font character set outside the font table",
      String.raw`{\rtf1\ansi{\fonttbl{\f0\fcharset178 A;}{\f0\fcharset0 B;}{\f1\fcharset0 C;}{\f2\fcharset178 D;}{\f2 E;}}{\stylesheet{\s0\f1\fcharset178 N;}}\f0 \'e3\f1\'e3\f2\'e3}`,
      "ããã",
    ],
    ["destination symbol", String.raw`{\rtf1\ansi\u945\*Z}`, "αZ"],
    ["multiple units", String.raw`{\rtf1\ansi\uc4\u945?\tab\'3f\~Z}`, "αZ"],
    ["binary unit", String.raw`{\rtf1\ansi\u945\bin3 abcZ}`, "αZ"],
    ["large fallback", String.raw`{\rtf1\ansi\uc20\u945????????????????????Z}`, "αZ"],
    ["no fallback", String.raw`{\rtf1\ansi\uc0\u945Z}`, "αZ"],
    ["scoped count", String.raw`{\rtf1\ansi{\uc2\u945??}\u946?Z}`, "αβZ"],
  ] as const)("extracts RTF text: %s", ([name, source, expected]) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${name}.rtf`);
      NodeFS.writeFileSync(path, source);
      expect(yield* Effect.promise(() => extractDocumentText(path, ".rtf"))).toBe(expected);
      expect(yield* (yield* DocumentText.DocumentText).ensure(path)).toBe(path + ".txt");
      expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(expected);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps long GB18030 four-byte RTF runs intact up to the output limit", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, "gb18030-long.rtf");
      NodeFS.writeFileSync(
        path,
        Buffer.concat([
          Buffer.from(String.raw`{\rtf1\ansi\ansicpg54936 `, "latin1"),
          Buffer.from([0xd6, 0xd0]),
          Buffer.alloc(1_050_000 * 4, Buffer.from([0x81, 0x39, 0xee, 0x39])),
          Buffer.from("}", "latin1"),
        ]),
      );
      const text = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(text.search(/[^中㐀]/u)).toBe(1_000_000);
      expect(text.slice(1_000_000)).toBe(
        "\n\n[Extracted text truncated at document extraction limits.]",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([false, true])("limits the child heap for standalone=%s", (standalone) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const { execFile } = await vi.importActual<typeof NodeChildProcess>("node:child_process");
        const probe = vi.spyOn(NodeChildProcess, "execFile");
        probe.mockImplementation(((
          file: string,
          _args: readonly string[],
          options: NodeChildProcess.ExecFileOptionsWithStringEncoding,
          callback: (
            error: NodeChildProcess.ExecFileException | null,
            stdout: string,
            stderr: string,
          ) => void,
        ) =>
          execFile(
            file,
            [
              "-e",
              'process.stdout.write(String(require("node:v8").getHeapStatistics().heap_size_limit))',
            ],
            options,
            callback,
          )) as typeof NodeChildProcess.execFile);
        return probe;
      }),
      () =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const path = NodePath.join(config.attachmentsDir, "heap.rtf");
          NodeFS.writeFileSync(path, String.raw`{\rtf1 hello}`);
          const extracted = yield* Effect.gen(function* () {
            return yield* (yield* DocumentText.DocumentText).ensure(path);
          }).pipe(
            Effect.provide(Layer.fresh(DocumentText.layer)),
            Effect.provideService(HostProcess.IsExecutable, standalone),
            Effect.provideService(HostProcess.Environment, {
              ...process.env,
              NODE_OPTIONS: "--max-old-space-size=1024",
            }),
          );
          expect(extracted).toBe(path + ".txt");
          const heapLimit = Number(NodeFS.readFileSync(path + ".txt", "utf8"));
          expect(heapLimit).toBeGreaterThan(192 * 1024 * 1024);
          // Newer V8 versions reserve up to 192 MiB for the young generation as well.
          expect(heapLimit).toBeLessThanOrEqual(384 * 1024 * 1024);
        }).pipe(Effect.provide(layer)),
      (probe) => Effect.sync(() => probe.mockRestore()),
    ),
  );

  it.effect("extracts notebook cells and outputs once and keeps both readable paths", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const file = {
        ...attachment,
        id: attachment.id.replace(/txt$/, "ipynb"),
        name: "survey.ipynb",
        mimeType: "application/x-ipynb+json",
      };
      const path = NodePath.join(config.attachmentsDir, `${file.id}.ipynb`);
      const rawSource = String.raw`\begin{tabular}{lr} North & 120 \\ \end{tabular}`;
      const notebook = JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
          {
            cell_type: "code",
            source: ["print(43 * 7)"],
            outputs: [
              { output_type: "stream", name: "stdout", text: "\u001b[32m301\u001b[0m\n" },
              {
                output_type: "stream",
                name: "stderr",
                text: [
                  "\r\u001b[32m 10%|#         |\u001b[0m",
                  "\r\u001b[32m100%|##########|\u001b[0m\n",
                  "done\r",
                  "\n",
                ],
              },
              {
                output_type: "display_data",
                data: { "text/plain": ["\u001b[", "33m42\u001b[0m\n", "Next line"] },
                metadata: {},
              },
              {
                output_type: "display_data",
                data: { "text/plain": "raw\rvalue" },
                metadata: {},
              },
              {
                output_type: "error",
                ename: "ZeroDivisionError",
                evalue: "division by zero",
                traceback: [
                  "\u001b[32mCell In[1], line 1\u001b[0m",
                  "\u001b[31m----> 1 1 / 0\u001b[0m",
                  "ZeroDivisionError: division by zero",
                ],
              },
            ],
          },
          { cell_type: "raw", source: [rawSource] },
        ],
      });
      NodeFS.writeFileSync(path, notebook);
      const answers = yield* appendUserInputAttachmentPaths({
        answers: { q: "Read this" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [file] },
      });
      expect(answers.q).toContain(`text extracted to: ${JSON.stringify(path + ".txt")}`);
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Vessel: Larkspur");
      const extracted = NodeFS.readFileSync(`${path}.txt`, "utf8");
      expect(extracted).toContain("Output:\n301\n");
      expect(extracted).toContain("100%|##########|\ndone\n");
      expect(extracted).not.toContain("10%|#");
      expect(extracted).toContain("42\nNext line");
      expect(extracted).toContain("raw\rvalue");
      expect(extracted).toContain(`## Cell 3 (raw)\n${rawSource}`);
      expect(extracted).toContain(
        "ZeroDivisionError: division by zero\nCell In[1], line 1\n----> 1 1 / 0\nZeroDivisionError: division by zero",
      );
      expect(extracted).not.toContain("\u001b");
      expect(NodeFS.readFileSync(path, "utf8")).toBe(notebook);
      const before = NodeFS.statSync(path + ".txt").mtimeMs;
      // A changed binary would fail parsing if the cached extraction were not reused.
      NodeFS.writeFileSync(path, "invalid notebook");
      const documents = yield* DocumentText.DocumentText;
      const results = yield* Effect.all([documents.ensure(path), documents.ensure(path)], {
        concurrency: "unbounded",
      });
      expect(results).toEqual([path + ".txt", path + ".txt"]);
      expect(NodeFS.statSync(path + ".txt").mtimeMs).toBe(before);
      yield* Effect.gen(function* () {
        const cleanup = yield* Cleanup.ResourceCleanupService;
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path)).toBe(false);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
        NodeFS.writeFileSync(path + ".txt", "orphaned extraction");
        yield* cleanup.cleanupAttachments([file.id]);
        expect(NodeFS.existsSync(path + ".txt")).toBe(false);
      }).pipe(
        Effect.provide(
          Cleanup.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(TerminalManager.TerminalManager)({}),
                Layer.mock(PreviewManager.PreviewManager)({}),
                Layer.mock(DeviceService.DeviceService)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "preserves corrupt documents, PDFs and unknown binaries without an extracted path",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        for (const extension of ["docx", "ipynb", "zip", "pdf"]) {
          const file = {
            ...attachment,
            id: attachment.id.replace(/txt$/, extension),
            name: `broken.${extension}`,
          };
          const path = NodePath.join(config.attachmentsDir, `${file.id}.${extension}`);
          NodeFS.writeFileSync(path, "invalid document");
          const answers = yield* appendUserInputAttachmentPaths({
            answers: {},
            attachmentsDir: config.attachmentsDir,
            attachmentsByQuestionId: { q: [file] },
          });
          expect(answers.q).toContain(JSON.stringify(path));
          expect(answers.q).not.toContain("text extracted");
          expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
          expect(NodeFS.readFileSync(path, "utf8")).toBe("invalid document");
        }
      }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves office structure and EPUB reading order with bounded archives", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cases = [
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
            "chapter.xhtml":
              '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Guide</title></head><body><ol><li>Before boarding<div><ul><li>Check passports</li></ul></div></li></ol>Intro<ul><li>Read the checklist</li></ul><dl><dt>Visa</dt><dd>Requirements<ul><li>Photo</li></ul></dd></dl><div>Carry<dl><dt>Passport</dt><dd>Required</dd></dl></div><div>Leave <ul></ul>room</div><div>Keep <ul><li hidden="">Draft</li></ul>walking</div></body></html>',
          },
          expected: [
            "Before boarding\nCheck passports",
            "Intro\nRead the checklist",
            "Requirements\nPhoto",
            "Carry\nPassport\nRequired",
            "Leave room",
            "Keep walking",
          ],
        },
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
            "chapter.xhtml":
              '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Guide</title></head><body><table><tr><th>Region</th><th>Month</th><th>Revenue</th></tr><tr><td rowspan="2">North</td><td>June</td><td>400</td></tr><tr><td>July</td><td>520</td></tr></table></body></html>',
          },
          expected: ["North\tJune\t400\n\tJuly\t520"],
        },
        // Cells past the column limit truncate only when they hold text.
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
            "chapter.xhtml":
              '<html xmlns="http://www.w3.org/1999/xhtml"><body><table><tr><td>Heading</td><td rowspan="2" colspan="513"/></tr><tr><td>Next row</td></tr></table><p>After the table</p></body></html>',
          },
          expected: ["Heading", "Next row", "After the table"],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
            "chapter.xhtml":
              '<html xmlns="http://www.w3.org/1999/xhtml"><body><table><tr><td colspan="513">Heading</td><td>Out of range</td></tr></table><p>After the table</p></body></html>',
          },
          expected: ["Heading", "[Extracted text truncated"],
          absent: ["Out of range", "After the table"],
        },
        // Word stores object layout and field data outside the visible document text.
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>Total cost is </w:t><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><w:t>42 EUR.</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["Total cost is 42 EUR."],
          absent: ["1905000", "-635", "0042"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><wp:anchor><wp:positionH><wp:posOffset>1905000</wp:posOffset></wp:positionH><wp:positionV><wp:posOffset>-635</wp:posOffset></wp:positionV><wp14:sizeRelH><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV><wp14:pctHeight>0</wp14:pctHeight></wp14:sizeRelV></wp:anchor></w:drawing><cx:chart/></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:p></w:body></w:document>',
          },
          expected: ["Chart caption"],
          absent: ["1905000", "-635"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:wp="urn:wp" xmlns:wp14="urn:wp14" xmlns:mc="urn:mc"><w:body><w:p><w:r><w:t>As shown </w:t><w:fldChar><w:fldData>RU5ETk9URQ==</w:fldData></w:fldChar><w:t>(Smith 2020) earlier.</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["As shown (Smith 2020) earlier."],
          absent: ["RU5ETk9URQ=="],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": "<document><p>Readable despite embedded media</p></document>",
            "word/media/black.bmp": "\0".repeat(64 * 1024),
            "word/embeddings/unused.bin": "\0".repeat(33 * 1024 * 1024),
          },
          expected: ["Readable despite embedded media"],
          absent: ["[Extracted text truncated"],
        },
        ...["/word/../word/document2.xml", "word/document2.xml"].map((target) => ({
          ext: "docx",
          bounded: true,
          parts: {
            "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
            "word/document.xml": "<document><p>Stale draft</p></document>",
            "word/document2.xml": "<document><p>Launch moves to 3 March.</p></document>",
          },
          expected: ["Launch moves to 3 March."],
          absent: ["Stale draft", "[Skipped document part"],
        })),
        {
          ext: "docx",
          bounded: true,
          parts: {
            "_rels/.rels":
              '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/WORD/DOCUMENT.XML"/></Relationships>',
            "word/document.xml": "<document><p>Launch moves to 3 March.</p></document>",
          },
          expected: ["Launch moves to 3 March."],
          absent: ["[Skipped document part"],
        },
        ...[false, true].map((deep) => ({
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<document>${deep ? "<div>".repeat(129) + "Lost" + "</div>".repeat(129) : "<p/>".repeat(200_001)}</document>`,
          },
          expected: ["[Extracted text truncated at document extraction limits.]"],
          absent: ["Lost"],
        })),
        ...["ods", "odt", "odp", "docx"].flatMap((ext) =>
          [false, true].map((rows) => ({
            ext,
            bounded: true,
            parts: {
              [ext === "docx" ? "word/document.xml" : "content.xml"]:
                `<document><page><table><table-row${rows ? ' number-rows-repeated="10001"' : ""}><table-cell${rows ? "" : ' number-columns-repeated="513"'}><p>Repeated value</p></table-cell></table-row></table></page></document>`,
            },
            expected: [
              "Repeated value",
              "[Extracted text truncated at document extraction limits.]",
            ],
            occurrences: { text: "Repeated value", count: rows ? 10_000 : 512 },
          })),
        ),
        ...["ods", "odt", "odp", "docx"].map((ext) => ({
          ext,
          bounded: true,
          parts: {
            [ext === "docx" ? "word/document.xml" : "content.xml"]:
              `<document><page><table><table-row><table-cell><p>Kept</p></table-cell><table-cell number-columns-repeated="16383"> \n <p> \t </p> <s c="1048575"/> </table-cell></table-row><table-row number-rows-repeated="1048575"><table-cell> \n <p> \t </p> </table-cell></table-row></table></page></document>`,
          },
          expected: ["Kept"],
          absent: ["[Extracted text truncated", "\t"],
        })),
        ...["ods", "odt", "odp"].map((ext) => ({
          ext,
          bounded: true,
          parts: {
            "content.xml": `<document><page><table><table-row>
              <table-cell office:value-type="string" office:string-value="Harbor"/>
              <table-cell office:value-type="boolean" office:boolean-value="false"/>
              <table-cell office:value-type="date" office:date-value="2026-10-20"/>
              <table-cell office:value-type="time" office:time-value="PT2H30M"/>
              <table-cell office:value-type="currency" office:value="125.50" office:currency="USD"/>
              <table-cell office:value-type="percentage" office:value="0.25"/>
              <table-cell office:value-type="float" office:value="0"/>
              <table-cell office:value-type="string" office:string-value="Fallback"><p> \n </p></table-cell>
              <table-cell office:value-type="string" office:string-value="Unshown"><p>Displayed</p></table-cell>
              <table-cell office:value-type="void" office:value="Unshown"/>
              <table-cell office:value-type="currency" office:value=" " office:currency="Unshown"/>
              <table-cell office:value-type="percentage" office:value=" "/>
            </table-row></table></page></document>`,
          },
          expected: [
            "Harbor\tfalse\t2026-10-20\tPT2H30M\t125.50 USD\t0.25 [ODF value-type=percentage]\t0\tFallback\tDisplayed",
          ],
          absent: ["Unshown", "[Extracted text truncated"],
        })),
        ...[false, true].map((rows) => ({
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Limited" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/worksheets/a.xml": `<worksheet>${rows ? "<row><c><v>7</v></c></row>".repeat(10_001) : '<row><c r="A1"><v>7</v></c><c r="SS1"><v>Beyond</v></c></row>'}</worksheet>`,
          },
          expected: ["7", "[Extracted text truncated at document extraction limits.]"],
          absent: ["Beyond"],
        })),
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Padding" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/sharedStrings.xml": "<sst><si><t> \n </t></si><si><t>Present</t></si></sst>",
            "xl/worksheets/a.xml": `<worksheet>${'<row><c t="s"><v>0</v></c><c r="XFD1" t="inlineStr"><is><t> \t </t></is></c></row>'.repeat(10_001)}<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c r="XFD2"><v> \n </v></c></row></worksheet>`,
          },
          expected: ["Present"],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="bad" href="ch%ZZ.xhtml"/><item id="good" href="good.svg"/><itemref idref="bad"/><itemref idref="good"/></package>',
            "good.svg":
              '<svg xmlns="http://www.w3.org/2000/svg"><text>Readable SVG chapter</text></svg>',
          },
          expected: [
            "Readable SVG chapter",
            "[Skipped document part: chapter 1 (missing or invalid XML).]",
          ],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="ch1" href="q%3F1.xhtml?x=1#sec1"/><itemref idref="ch1"/></package>',
            "q?1.xhtml": "<html><p>Encoded question mark chapter text.</p></html>",
          },
          expected: ["Encoded question mark chapter text."],
          absent: ["[Skipped document part", "[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml":
              '<container><rootfile full-path="My%20Book/book%201.opf"/></container>',
            "My Book/book 1.opf":
              '<package><item id="ch1" href="ch1.xhtml"/><itemref idref="ch1"/></package>',
            "My Book/ch1.xhtml": "<html><p>Percent-encoded rootfile chapter text.</p></html>",
          },
          expected: ["Percent-encoded rootfile chapter text."],
          absent: ["[Skipped document part", "[Extracted text truncated"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml":
              '<container><rootfile full-path="OPS/book%201.opf"/></container>',
            "OPS/book%201.opf":
              '<package><item id="ch1" href="correct.xhtml"/><itemref idref="ch1"/></package>',
            "ops/book 1.opf":
              '<package><item id="ch1" href="other.xhtml"/><itemref idref="ch1"/></package>',
            "OPS/correct.xhtml": "<html><p>Correct primary chapter</p></html>",
            "ops/other.xhtml": "<html><p>Wrong alternate chapter</p></html>",
          },
          expected: ["Correct primary chapter"],
          absent: ["Wrong alternate chapter", "[Skipped document part"],
        },
        ...[false, true].flatMap((bom) =>
          [false, true].map((bigEndian) => {
            const encode = (source: string) => {
              const data = Buffer.from(`${bom ? "\ufeff" : ""}${source}`, "utf16le");
              return bigEndian ? data.swap16() : data;
            };
            return {
              ext: "epub",
              parts: {
                "META-INF/container.xml": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><container><rootfile full-path="book.opf"/></container>',
                ),
                "book.opf": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><package><item id="a" href="a.xhtml"/><itemref idref="a"/></package>',
                ),
                "a.xhtml": encode(
                  '<?xml version="1.0" encoding="UTF-16"?><html><p>UTF-16 chapter: café 日本語</p></html>',
                ),
              },
              expected: ["UTF-16 chapter: café 日本語"],
              absent: ["[Skipped document part", "[Extracted text truncated"],
            };
          }),
        ),
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="bad" href="bad.xhtml"/><item id="good" href="good.xhtml"/><itemref idref="bad"/><itemref idref="good"/></package>',
            "bad.xhtml": "<html><p>Discard this broken chapter</html>",
            "good.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><p>North&nbsp;Harbor &NotEqualTilde; &CounterClockwiseContourIntegral; &amp; &lt;tag&gt; &quot;quoted&quot;</p><p><![CDATA[Literal &nbsp;]]></p><table><tr><td>&nbsp; </td></tr><tr><td>Kept&nbsp;cell</td></tr></table></html>',
          },
          expected: [
            "## Chapter 2",
            'North\u00a0Harbor ≂̸ ∳ & <tag> "quoted"',
            "Literal &nbsp;",
            "Kept cell",
            "[Skipped document part: bad.xhtml (missing or invalid XML).]",
          ],
          absent: ["Discard this broken chapter", "[Extracted text truncated"],
        },
        ...["pptx", "xlsx"].map((ext) => ({
          ext,
          bounded: true,
          parts:
            ext === "pptx"
              ? {
                  "ppt/presentation.xml":
                    '<presentation><sldIdLst><sldId r:id="bad"/><sldId r:id="good"/></sldIdLst></presentation>',
                  "ppt/_rels/presentation.xml.rels":
                    '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
                  "ppt/bad.xml": "<slide><p>Discard</slide>",
                  "ppt/good.xml": "<slide><p>Healthy part</p></slide>",
                }
              : {
                  "xl/workbook.xml":
                    '<workbook><sheet name="Bad" r:id="bad"/><sheet name="Good" r:id="good"/></workbook>',
                  "xl/_rels/workbook.xml.rels":
                    '<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
                  "xl/bad.xml": "<worksheet><row>Discard</worksheet>",
                  "xl/good.xml":
                    '<worksheet><row><c t="inlineStr"><is><t>Healthy part</t></is></c></row></worksheet>',
                },
          expected: [
            "Healthy part",
            `[Skipped document part: ${ext === "pptx" ? "ppt" : "xl"}/bad.xml (missing or invalid XML).]`,
          ],
          absent: ["Discard", "[Extracted text truncated"],
        })),
        {
          ext: "odt",
          bounded: true,
          parts: { "content.xml": '<document><p>Start<s c="1000001"/>Unneeded</p></document>' },
          expected: ["Start", "[Extracted text truncated at document extraction limits.]"],
          absent: ["Unneeded"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": [
              '<w:document xmlns:w="urn:w" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:q="urn:quiz"><w:body>',
              "<w:p><w:r><w:t>Body</w:t></w:r></w:p>",
              '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></mc:Choice><mc:Choice Requires="w14"><w:r><w:t>Callout box</w:t></w:r></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Callout box</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p>',
              '<w:p><w:r><w:t xml:space="preserve">Amount due: </w:t></w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Choice Requires="w15"><w:r><w:t>$75</w:t></w:r><mc:AlternateContent><mc:Choice Requires="w16"><w:r><w:t xml:space="preserve"> USD</w:t></w:r></mc:Choice><mc:Choice Requires="w14"><w:r><w:t xml:space="preserve"> USD</w:t></w:r></mc:Choice></mc:AlternateContent></mc:Choice><mc:Choice Requires="w14"><w:r><w:t>$75</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>$75</w:t></w:r></mc:Fallback></mc:AlternateContent><w:r><w:t>.</w:t></w:r></w:p>',
              '<w:p><w:r><w:t>Amount:</w:t></w:r><mc:AlternateContent><mc:Choice Requires="w16"><w:r><w:tab/></w:r></mc:Choice><mc:Choice Requires="w15"><w:r><w:t xml:space="preserve"> </w:t></w:r></mc:Choice><mc:Choice Requires="w14"><w:r><w:t>$75</w:t></w:r></mc:Choice></mc:AlternateContent></w:p>',
              "<w:p><q:AlternateContent><q:Choice><w:r><w:t>Alpha</w:t></w:r></q:Choice><q:Choice><w:r><w:t>Beta</w:t></w:r></q:Choice></q:AlternateContent></w:p>",
              '<w:p><mc:AlternateContent><q:Choice><w:r><w:t>Extension</w:t></w:r></q:Choice><mc:Choice Requires="w14"><w:r><w:t>Invoice</w:t></w:r></mc:Choice></mc:AlternateContent></w:p>',
              "</w:body></w:document>",
            ].join(""),
          },
          expected: [
            "Body\nCallout box\nSecond line",
            "Amount due: $75 USD.",
            "Amount:$75",
            "AlphaBeta",
            "ExtensionInvoice",
          ],
          occurrences: { text: "Callout box", count: 1 },
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body><w:p><w:r><mc:AlternateContent><mc:Choice Requires="cx"><w:drawing><cx:chart/></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent><w:p><w:r><w:t>Chart caption</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent></w:r></w:p></w:body></w:document>',
          },
          expected: ["Chart caption"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:wps="urn:wps"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:sdt><w:sdtPr><w:alias w:val="Title"/></w:sdtPr><w:sdtContent><w:tc><w:p><w:r><w:t>Annual report</w:t></w:r></w:p></w:tc></w:sdtContent></w:sdt><w:tc><w:p><w:r><w:t>Draft</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:noBreakHyphen/></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:pPr><w:pPrChange><w:pPr><w:pStyle w:val="Heading2"/></w:pPr></w:pPrChange></w:pPr><w:r><w:t>Demoted</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Intro. </w:t></w:r><w:r><w:drawing><wps:wsp><wps:txbx><w:txbxContent><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Box title</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></w:drawing></w:r></w:p></w:body></w:document>',
          },
          expected: [
            "## Report & totals",
            "North\t12 34",
            "Annual report\tDraft",
            "Before Inner After\tNeighbor\t\u2011\n\u2011\nDemoted\nIntro. # Box title",
          ],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:tbl>' +
              "<w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc></w:tr>" +
              '<w:tr><w:tc><w:p><w:r><w:t>Tail</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>End</w:t></w:r></w:p></w:tc></w:tr>' +
              '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>Merged</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Total</w:t></w:r></w:p></w:tc></w:tr>' +
              '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="0"/></w:tcPr><w:p><w:r><w:t>Zero</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Next</w:t></w:r></w:p></w:tc></w:tr>' +
              '<w:tr><w:tc><w:tcPr><w:gridSpan w:val="513"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc></w:tr>' +
              "</w:tbl></w:body></w:document>",
          },
          expected: [
            "A\tB\tC\nTail\tEnd\nMerged\t\tTotal\nZero\tNext",
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["Wide"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": [
              '<w:document xmlns:w="urn:w" xmlns:mc="urn:mc"><w:body>',
              '<w:p><w:r><w:t>First</w:t><w:cr/><w:t>Second</w:t><w:br/><w:t>Third</w:t><w:noBreakHyphen/><w:t>party</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:noBreakHyphen/></mc:Choice><mc:Fallback><w:t>‑</w:t></mc:Fallback></mc:AlternateContent><w:t>End</w:t></w:r></w:p>',
              '<w:p><w:r><w:t>Invoice 104</w:t><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/><w:t>$700.00</w:t></w:r></w:p>',
              '<w:p><w:r><w:t>Invoice 105</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/></mc:Choice><mc:Fallback><w:tab/></mc:Fallback></mc:AlternateContent><w:t>$800.00</w:t></w:r></w:p>',
              '<w:p><w:r><w:t>Invoice 106</w:t><mc:AlternateContent><mc:Choice Requires="w"><w:ptab w:alignment="right" w:relativeTo="margin" w:leader="none"/></mc:Choice><mc:Fallback><w:t xml:space="preserve"> total </w:t></mc:Fallback></mc:AlternateContent><w:t>$900.00</w:t></w:r></w:p>',
              "</w:body></w:document>",
            ].join(""),
          },
          expected: [
            "First\nSecond\nThird\u2011party\u2011End\nInvoice 104\t$700.00\nInvoice 105\t$800.00\nInvoice 106 total $900.00",
          ],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Intro</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t> 3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:p><w:pPr><w:tabs><w:tab w:val="right" w:pos="9350"/></w:tabs></w:pPr><w:r><w:t xml:space="preserve">Fee </w:t></w:r><w:del><w:r><w:delText>$500</w:delText><w:noBreakHyphen/></w:r></w:del><w:ins><w:r><w:t>$700</w:t></w:r></w:ins><w:moveFrom><w:r><w:t>Moved</w:t></w:r></w:moveFrom><w:r><w:tab/><w:t>due</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["Intro 3\nFee $700\tdue"],
          absent: ["PAGEREF", "$500", "Moved", "\u2011"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml":
              '<w:document xmlns:w="urn:w" xmlns:m="urn:m"><w:body><w:p><w:r><w:t xml:space="preserve">Opening </w:t></w:r><m:oMath><m:r><m:rPr><m:sty m:val="p"/></m:rPr><w:rPr><w:vanish/></w:rPr><m:t>Formula</m:t></m:r></m:oMath><w:r><w:rPr><w:vanish/></w:rPr><w:t>Omitted</w:t></w:r><w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t xml:space="preserve">Zero </w:t></w:r><w:r><w:rPr><w:vanish w:val="false"/></w:rPr><w:t xml:space="preserve">False </w:t></w:r><w:r><w:rPr><w:vanish w:val="off"/></w:rPr><w:t xml:space="preserve">Off </w:t></w:r><w:r><w:rPr><w:vanish w:val="true"/></w:rPr><w:t>Draft</w:t></w:r><w:r><w:rPr><w:vanish w:val="1"/></w:rPr><w:t>Note</w:t></w:r><w:r><w:rPr><w:vanish w:val="on"/></w:rPr><w:t>Aside</w:t></w:r><w:r><w:rPr><w:rPrChange><w:rPr><w:vanish/></w:rPr></w:rPrChange></w:rPr><w:t>Shown</w:t></w:r></w:p></w:body></w:document>',
          },
          expected: ["Opening Zero False Off Shown"],
          absent: ["Omitted", "Draft", "Note", "Aside", "Formula"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml":
              "<document><text><tracked-changes><changed-region><deletion><change-info><creator>Reviewer</creator></change-info><p>$500</p></deletion></changed-region></tracked-changes><p>Fee <change/>$700</p></text></document>",
          },
          expected: ["Fee $700"],
          absent: ["Reviewer", "$500"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml":
              '<document><text><p>Fee <office:annotation><dc:creator>Reviewer</dc:creator><dc:date>2026-01-01T00:00:00</dc:date><initials>JR</initials><p>Check</p></office:annotation>$700</p><table><table-row><table-cell office:value-type="float" office:value="150"><office:annotation><p>was 120</p></office:annotation></table-cell></table-row></table><p>Formula <math:math><math:semantics><math:mrow>x+y</math:mrow><math:annotation encoding="application/x-tex">x+y</math:annotation></math:semantics></math:math></p></text></document>',
          },
          expected: ["Fee $700\n150\nFormula x+yx+y"],
          absent: ["Reviewer", "2026-01-01", "JR", "Check", "was 120"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml":
              '<office:document-content><office:automatic-styles><number:currency-style style:name="N1"><number:currency-symbol>USD</number:currency-symbol><number:number number:decimal-places="2" number:min-integer-digits="1"/></number:currency-style></office:automatic-styles><office:body><office:text><text:p>Invoice was paid in euros.</text:p></office:text></office:body></office:document-content>',
          },
          expected: ["Invoice was paid in euros."],
          absent: ["USD"],
        },
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<w:document><w:body><w:tbl><w:tr><w:tc><w:p><w:r><w:t>${"A".repeat(1_000_000)}</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Later cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
          },
          expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Formulas" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="9"/></cellXfs></styleSheet>',
            "xl/worksheets/a.xml":
              "<worksheet><row><c><f>SUM(11,22)</f><v/></c></row><row><c><f>SUM(33,44)</f><v> \n </v></c></row><row><c><f>SUM(55,66)</f></c></row><row><c><f>SUM(11,22)</f><v>33</v></c><c><f>SUM(0,0)</f><v>0</v></c></row></worksheet>",
          },
          expected: [
            "SUM(11,22)\nSUM(33,44)\nSUM(55,66)",
            "33 [Excel numFmtId=9; date system 1900]\t0 [Excel numFmtId=9; date system 1900]",
          ],
          absent: ["SUM(0,0)", "[Extracted text truncated"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Flags" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/worksheets/a.xml":
              '<worksheet><row><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="n"><v>1</v></c><c r="D1" t="b"><v>2</v></c></row></worksheet>',
          },
          expected: ["true\tfalse\t1\t2"],
        },
        {
          ext: "xlsx",
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/><Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="../catalog/items.xml"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="../Formatting/Cells.xml"/></Relationships>',
            "catalog/items.xml": "<sst><si><t>Lantern</t></si></sst>",
            "formatting/cells.xml":
              '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>',
            "xl/worksheets/second.xml":
              '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="C1"><v>37</v></c></row></sheetData></worksheet>',
            "xl/worksheets/first.xml":
              '<worksheet><sheetData><row><c t="inlineStr"><is><t>Ferry</t></is></c><c><v>628</v></c><c s="1"><v>45292</v></c><c s="2"><v>0.25</v></c><c s="3"><v>45293</v></c></row></sheetData></worksheet>',
          },
          expected: [
            "## Sheet: Inventory",
            "Lantern\t\t37",
            "## Sheet: Budget",
            "Ferry\t628",
            "45292 [Excel numFmtId=14; date system 1900]",
            "0.25 [Excel numFmtId=9; date system 1900]",
            "45293 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1900]",
          ],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "_rels/.rels":
              '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="docs/book.xml"/></Relationships>',
            "docs/book.xml": '<workbook><sheets><sheet name="Data" r:id="a"/></sheets></workbook>',
            "docs/_rels/book.xml.rels":
              '<Relationships><Relationship Id="a" Target="sheets/data.xml"/><Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="strings.xml"/></Relationships>',
            "docs/strings.xml": "<sst><si><t>Harbor</t></si></sst>",
            "docs/styles.xml":
              '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
            "docs/sheets/data.xml":
              '<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>45293</v></c></row></sheetData></worksheet>',
          },
          expected: [
            "## Sheet: Data",
            "Harbor\t45293 [Excel numFmtId=164; format=yyyy-mm-dd; date system 1900]",
          ],
          absent: ["[Skipped document part"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Phonetics" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/sharedStrings.xml":
              '<sst><si><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></si></sst>',
            "xl/worksheets/a.xml":
              '<worksheet><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>東京</t><rPh sb="0" eb="2"><t>とうきょう</t></rPh></is></c></row></worksheet>',
          },
          expected: ["## Sheet: Phonetics", "東京\t東京"],
          absent: ["とうきょう"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml": '<workbook><sheet name="Escapes" r:id="a"/></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/a.xml"/></Relationships>',
            "xl/sharedStrings.xml":
              "<sst><si><t>first_x000D_\nsecond</t></si><si><t>_x005F_x0041_</t></si><si><t>_x005F_x005F_x0041_</t></si><si><r><t>Bold_x000D_</t></r><r><t>_x005F_x000D_</t></r></si><si><t>&amp;_xnothex_ cap_X0041_ _x000d_ tail</t></si></sst>",
            "xl/worksheets/a.xml":
              '<worksheet><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c><c t="s"><v>3</v></c><c t="s"><v>4</v></c></row><row><c t="inlineStr"><is><t>_x005F_x005F_</t></is></c><c t="inlineStr"><is><t>first_x000D_second</t></is></c><c t="str"><f>A1</f><v>Total_x000D_due</v></c></row></worksheet>',
          },
          expected: [
            "## Sheet: Escapes\nfirst second\t_x0041_\t_x005F_x0041_\tBold _x000D_\t&_xnothex_ cap_X0041_ tail\n_x005F_\tfirst second\tTotal due",
          ],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml":
              '<workbook><workbookPr date1904="true"/><sheets><sheet name="Dates" r:id="a"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/dates.xml"/></Relationships>',
            "xl/styles.xml": '<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>',
            "xl/worksheets/dates.xml":
              "<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>",
          },
          expected: ["## Sheet: Dates", "1 [Excel numFmtId=14; date system 1904]"],
        },
        {
          ext: "xlsx",
          bounded: true,
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Repeated" r:id="a"/><sheet name="Unneeded" r:id="missing"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/repeated.xml"/></Relationships>',
            "xl/sharedStrings.xml": `<sst><si><t>${"A".repeat(1_000_000 - "## Sheet: Repeated\n".length)}</t></si></sst>`,
            "xl/worksheets/repeated.xml": `<worksheet><sheetData>${'<row><c t="s"><v>0</v></c><c t="s"><v>0</v></c></row>'.repeat(1_500)}</sheetData></worksheet>`,
          },
          expected: [
            "## Sheet: Repeated",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
        },
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
              xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main">
              <p:sldIdLst xmlns:links="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
                <p:sldId r:id="b" id="256"/><p:sldId links:id="a" id="257"/>
              </p:sldIdLst>
              <p:extLst><p:ext uri="{521415D9-36F7-43E2-AB2F-B90AF26B5E84}"><p14:sectionLst>
                <p14:section name="Schedule" id="{01F07B81-39E6-4BBB-9B89-66EA253FBD29}">
                  <p14:sldIdLst><p14:sldId id="256"/><p14:sldId id="257"/></p14:sldIdLst>
                </p14:section>
              </p14:sectionLst></p:ext></p:extLst>
            </p:presentation>`,
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
            "ppt/slides/slide1.xml":
              '<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p><p:timing><p:tnLst><p:par><p:cTn id="1"><p:childTnLst><p:set><p:cBhvr><p:cTn id="2"/><p:tgtEl><p:spTgt spid="2"/></p:tgtEl><p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set></p:childTnLst></p:cTn></p:par></p:tnLst></p:timing></p:sld>',
            "ppt/slides/slide2.xml":
              '<p:sld><a:p><x:timing><a:r><a:t>Juniper Pier</a:t></a:r></x:timing></a:p><mc:AlternateContent><mc:Choice Requires="p14"><p:timing><p:attrName>ppt_x</p:attrName></p:timing></mc:Choice></mc:AlternateContent></p:sld>',
            "ppt/slides/_rels/slide2.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../notesSlides/ignored.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" TargetMode="External" Target="https://example.com/notes.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes7.xml"/></Relationships>',
            "ppt/slides/_rels/slide1.xml.rels":
              '<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="/ppt/notesSlides/notes3.xml"/></Relationships>',
            "ppt/notesSlides/notes7.xml":
              '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>evacuation code ORCHID-81</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="hdr" sz="quarter"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Harbor briefing</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="dt" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="datetime1"><a:t>11/21/2026</a:t></a:fld></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="ftr" sz="quarter" idx="4"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Crew only</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" sz="quarter" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>57</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
            "ppt/notesSlides/notes3.xml":
              "<p:notes><a:p><a:r><a:t>Board at gate 4</a:t></a:r></a:p></p:notes>",
            "ppt/notesSlides/ignored.xml": "<p:notes><a:p>Unrelated notes</a:p></p:notes>",
          },
          expected: [
            "## Slide 1",
            "Juniper Pier\nNotes:\nevacuation code ORCHID-81",
            "## Slide 2",
            "Departure\nNotes:\nBoard at gate 4",
          ],
          occurrences: { text: "## Slide ", count: 2 },
          absent: [
            "Unrelated notes",
            "Harbor briefing",
            "11/21/2026",
            "Crew only",
            "57",
            "style.visibility",
            "ppt_x",
            "[Skipped document part",
            "[Extracted text truncated",
          ],
        },
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
            "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
            "ppt/slides/_rels/a.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/empty.xml"/></Relationships>',
            "ppt/notesSlides/empty.xml":
              '<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:endParaRPr/></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum" idx="5"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:fld type="slidenum"><a:t>57</a:t></a:fld></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
          },
          expected: ["Slide text"],
          absent: ["Notes:", "57"],
        },
        ...[
          { target: "deck/main.xml", prefix: "deck/" },
          { target: "/main.xml", prefix: "" },
        ].map(({ target, prefix }) => ({
          ext: "pptx",
          bounded: true,
          parts: {
            "_rels/.rels": `<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`,
            [`${prefix}main.xml`]:
              '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
            [`${prefix}_rels/main.xml.rels`]:
              '<Relationships><Relationship Id="a" Target="slides/one.xml"/></Relationships>',
            [`${prefix}slides/one.xml`]:
              "<p:sld><a:p><a:r><a:t>Harbor launch</a:t></a:r></a:p></p:sld>",
            [`${prefix}slides/_rels/one.xml.rels`]:
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notes/n1.xml"/></Relationships>',
            [`${prefix}notes/n1.xml`]:
              "<p:notes><a:p><a:r><a:t>Check tide table</a:t></a:r></a:p></p:notes>",
          },
          expected: ["## Slide 1", "Harbor launch\nNotes:\nCheck tide table"],
          absent: ["[Skipped document part"],
        })),
        ...[false, true].map((missing) => ({
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<presentation><sldIdLst><sldId r:id="a"/></sldIdLst></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/a.xml"/></Relationships>',
            "ppt/slides/a.xml": "<slide><p>Slide text</p></slide>",
            "ppt/slides/_rels/a.xml.rels": `<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/${missing ? "missing" : "bad"}.xml"/></Relationships>`,
            "ppt/notesSlides/bad.xml": "<notes><p>Discard broken notes</notes>",
          },
          expected: [
            "Slide text",
            `[Skipped document part: ppt/notesSlides/${missing ? "missing" : "bad"}.xml (missing or invalid XML).]`,
          ],
          absent: ["Discard broken notes", "[Extracted text truncated"],
        })),
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<presentation><sldIdLst><sldId r:id="a"/><sldId r:id="b"/></sldIdLst></presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/a.xml"/><Relationship Id="b" Target="slides/b.xml"/></Relationships>',
            "ppt/slides/a.xml": `<slide><p>${"A".repeat(600_000)}</p></slide>`,
            "ppt/slides/b.xml": "<slide><p>Unneeded slide</p></slide>",
            "ppt/slides/_rels/a.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/a.xml"/></Relationships>',
            "ppt/notesSlides/a.xml": `<notes><p>evacuation code ORCHID-81 ${"B".repeat(600_000)} Unneeded notes</p></notes>`,
          },
          expected: [
            "## Slide 1",
            "A".repeat(32),
            "Notes:\nevacuation code ORCHID-81",
            "B".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["Unneeded notes", "Unneeded slide", "## Slide 2"],
        },
        {
          ext: "odt",
          parts: {
            "content.xml":
              '<office:document><text:h text:outline-level="2">\n  Orchard\n</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates <text:span>\n\t  shipped</text:span>   today<text:tab/>Dock<text:line-break/>Gate\u00a0B </text:p><text:p>Second</text:p><text:p>A<text:span><text:script>console.log(1);\n</text:script></text:span> B</text:p>' +
              [
                "table-of-content",
                "illustration-index",
                "table-index",
                "object-index",
                "user-index",
                "alphabetical-index",
                "bibliography",
              ]
                .map(
                  (name) =>
                    `<text:${name}><text:${name}-source><text:index-title-template>Contents</text:index-title-template><text:${name}-entry-template><text:index-entry-span>: </text:index-entry-span></text:${name}-entry-template></text:${name}-source><text:index-body><text:index-title><text:p>Contents</text:p></text:index-title><text:p>Orchard 1</text:p></text:index-body></text:${name}>`,
                )
                .join("") +
              "</office:document>",
          },
          expected: [
            `## Orchard\n19   violet crates shipped today\tDock\nGate\u00a0B\nSecond\nA B${"\nContents\nOrchard 1".repeat(7)}`,
          ],
        },
        {
          ext: "ods",
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Cargo"><table:table-row><table:table-cell><text:p>Violet</text:p></table:table-cell><table:table-cell office:value="19"/><table:table-cell office:value="27"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Cargo", "Violet\t19\t27"],
        },
        {
          ext: "ods",
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Merged">' +
              '<table:table-row><table:table-cell table:number-columns-spanned="3" table:number-rows-spanned="2"><text:p>Wide</text:p></table:table-cell><table:covered-table-cell office:value-type="float" office:value="4242"/><table:covered-table-cell office:value-type="string" office:string-value="Gone"/><table:table-cell table:number-columns-spanned="2"><text:p>After</text:p></table:table-cell><table:covered-table-cell><text:p>Tail</text:p></table:covered-table-cell></table:table-row>' +
              '<table:table-row><table:covered-table-cell table:number-columns-repeated="3"><text:p>Below</text:p></table:covered-table-cell><table:table-cell><text:p>Next</text:p></table:table-cell></table:table-row>' +
              "<table:table-row><table:covered-table-cell><text:p>Only</text:p></table:covered-table-cell></table:table-row>" +
              "<table:table-row><table:table-cell><text:p>Last</text:p></table:table-cell></table:table-row></table:table></office:document>",
          },
          expected: ["## Sheet: Merged", "Wide\t\t\tAfter\n\t\t\tNext\nLast"],
          absent: ["4242", "Gone", "Tail", "Below", "Only", "After\t"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Padded rows"><table:table-row><table:table-cell><text:p>Left</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell><text:p>Right</text:p></table:table-cell></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell/></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Padded rows", "Left\t\t\tRight"],
          absent: ["[Extracted text truncated"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml":
              '<office:document><table:table table:name="Padded"><table:table-row><table:table-cell><text:p>Populated</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p/></table:table-cell></table:table-row></table:table></office:document>',
          },
          expected: ["## Sheet: Padded", "Populated"],
          absent: ["[Extracted text truncated", "\t"],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml": `<office:document><table:table table:name="Repeated"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>Lead ${"a".repeat(600_000)} Tail</text:p></table:table-cell></table:table-row></table:table></office:document>`,
          },
          expected: [
            "## Sheet: Repeated",
            "Lead ",
            " Tail\tLead ",
            "[Extracted text truncated at document extraction limits.]",
          ],
        },
        {
          ext: "odp",
          parts: {
            "content.xml":
              "<office:document>" +
              "<draw:page><draw:frame><draw:text-box><text:p>\n  First\n\t  slide </text:p></draw:text-box></draw:frame>" +
              "<svg:title>Overview</svg:title>" +
              "<presentation:notes><draw:frame><draw:text-box><text:p>Speaker only</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>" +
              "<draw:page><text:p>Second</text:p><presentation:notes><draw:g><draw:page-thumbnail>" +
              "<svg:title>Slide preview</svg:title><svg:desc>Thumbnail metadata</svg:desc>" +
              "</draw:page-thumbnail></draw:g></presentation:notes></draw:page>" +
              "<draw:page><text:p>Third</text:p><presentation:notes><draw:frame><draw:text-box>" +
              '<table:table><table:table-column/><table:table-row><table:table-cell office:value-type="float" office:value="42"/></table:table-row></table:table>' +
              "</draw:text-box></draw:frame></presentation:notes></draw:page></office:document>",
          },
          expected: [
            "## Slide 1\nFirst slide\nOverview\nNotes:\nSpeaker only\n\n## Slide 2\nSecond\n\n## Slide 3\nThird\n\nNotes:\n42",
          ],
        },
        {
          ext: "ods",
          bounded: true,
          parts: {
            "content.xml": `<office:document>${Array.from(
              { length: 256 },
              (_, index) =>
                `<table:table table:name="${index === 0 ? "Shared" : "Unneeded"}"><table:table-row><table:table-cell table:number-columns-repeated="512"><text:p>${"B".repeat(4096)}</text:p></table:table-cell></table:table-row></table:table>`,
            ).join("")}</office:document>`,
          },
          expected: [
            "## Sheet: Shared",
            "B".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Sheet: Unneeded"],
        },
        {
          ext: "odt",
          bounded: true,
          parts: {
            "content.xml": `<office:document><text:p>Before whitespace</text:p><table:table><table:table-row table:number-rows-repeated="10000"><table:table-cell table:number-columns-repeated="512"><text:p>${" ".repeat(10_000)}</text:p></table:table-cell></table:table-row></table:table><text:p>Unneeded</text:p></office:document>`,
          },
          expected: ["Before whitespace", "Unneeded"],
          absent: ["[Extracted text truncated"],
        },
        ...["odt", "odp", "ods"].flatMap((ext) =>
          [false, true].map((rows) => ({
            ext,
            bounded: true,
            parts: {
              "content.xml": `<office:document><draw:page>${Array.from(
                { length: 256 },
                () =>
                  `<table:table><table:table-row${rows ? ' table:number-rows-repeated="10000"' : ""}><table:table-cell table:number-columns-repeated="512"><text:p>${"Budget ".repeat(rows ? 160 : 585)}</text:p></table:table-cell></table:table-row></table:table>`,
              ).join(
                "",
              )}</draw:page><draw:page><text:p>Unneeded</text:p></draw:page></office:document>`,
            },
            expected: ["Budget ", "[Extracted text truncated at document extraction limits.]"],
            absent: ["Unneeded"],
          })),
        ),
        {
          ext: "docx",
          bounded: true,
          parts: {
            "word/document.xml": `<w:document><w:p><w:t>${"A".repeat(1_000_100)}</w:t></w:p><w:p><w:t>Unneeded</w:t></w:p></w:document>`,
          },
          expected: ["A".repeat(32), "[Extracted text truncated at document extraction limits.]"],
          absent: ["Unneeded"],
        },
        {
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml":
              '<p:presentation><p:sldIdLst><p:sldId r:id="a"/><p:sldId r:id="missing"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide.xml"/></Relationships>',
            "ppt/slides/slide.xml": `<p:sld><a:p><a:t>${"A".repeat(1_000_100)}</a:t></a:p></p:sld>`,
          },
          expected: [
            "## Slide 1",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Slide 2"],
        },
        {
          ext: "epub",
          bounded: true,
          parts: {
            "META-INF/container.xml": '<container><rootfile full-path="book.opf"/></container>',
            "book.opf":
              '<package><item id="a" href="a.xhtml"/><itemref idref="a"/><itemref idref="missing"/></package>',
            "a.xhtml": `<html><body><p>${"A".repeat(1_000_100)}</p></body></html>`,
          },
          expected: [
            "## Chapter 1",
            "A".repeat(32),
            "[Extracted text truncated at document extraction limits.]",
          ],
          absent: ["## Chapter 2"],
        },
        {
          ext: "epub",
          parts: {
            "META-INF/container.xml":
              '<container><rootfile full-path="OEBPS/book.opf"/></container>',
            "OEBPS/book.opf":
              '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a" hidden=""/><itemref idref="c"/></spine></package>',
            "OEBPS/a.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p><div>Totals<table><caption>Table 1: Revenue</caption><tr><th>Q1</th><th>Q2</th></tr><tr><td>100</td><td>200</td></tr></table></div><table><caption><p>Table 2: Costs</p></caption><tr><td>Rent</td></tr></table><p>Price <s>10</s> 8 <del>old</del></p><p><ruby>山路<rt>やまみち</rt></ruby>を歩く。<ruby>東京<rp>（</rp><script type="application/json">{}</script><rt>とうきょう</rt><script type="application/json">{}</script><rp>）</rp></ruby>に着く。<ruby>川<rt/></ruby>を見る。<ruby>海<rp/><rt>うみ</rt><rp> </rp></ruby>まで。</p></body></html>',
            "OEBPS/b.xhtml":
              '<!DOCTYPE html><html><head><title>My Novel</title><meta name="author" content="Hidden Author"/></head><body><h1>First chapter</h1><p>Larkspur</p><p>Map: <img src="map.png" alt="North &amp; south piers"/> open<img src="blank.png" alt=""/><img src="missing.png"/>.</p><div><img src="cover.png" alt="Cover art"/></div><img hidden="" src="draft.png" alt="Hidden image text"/><img src="none.png" alt="Display none image" style="width: 1em; DISPLAY: none"/><img src="invisible.png" alt="Invisible image" style="visibility:hidden !important"/><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><div>Account: A<br/>Balance: 731<line-break/>Currency: USD</div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr><tr><td>Before<table><tr><td>Inner</td></tr></table>After</td><td>Neighbor</td></tr></tbody></table><dl><dt>Port</dt><dd>443</dd><dt>Timeout</dt><dd>30 seconds</dd></dl><p hidden="">Draft note</p><div hidden="hidden">Hidden block<p>Hidden nested</p></div><p hidden="UNTIL-FOUND">Findable note</p><p aria-hidden="true">Decorative note</p><p x:hidden="true">Prefixed note</p><ol><li>Before boarding<ul><li>Check passports<ol><li>Compare names</li></ol></li><li>Confirm gate</li></ul></li><li>Board promptly</li><li><p>Before landing</p><ul><li>Collect bags</li></ul></li></ol>' +
              "<ol><li>Indented\n  <ul><li>Alpha</li></ul></li></ol></body></html>",
            "OEBPS/c.xhtml": '<html hidden=""><body><p>Root hidden</p></body></html>',
          },
          expected: [
            "## Chapter 1",
            "\n# First chapter",
            "Larkspur",
            "Map: North & south piers open.",
            "Cover art",
            "Direct div",
            "Direct section",
            "Direct item emphasis trailing",
            "Account: A\nBalance: 731\nCurrency: USD",
            "Heading\tTotal",
            "Important value\t731",
            "Before Inner After\tNeighbor",
            "Port\n443\nTimeout\n30 seconds",
            "Findable note\nDecorative note\nPrefixed note",
            "Before boarding\nCheck passports\nCompare names\n\nConfirm gate\n\nBoard promptly",
            "Before landing\nCollect bags",
            "Indented\n  Alpha",
            "## Chapter 2",
            "Last chapter",
            "Totals\nTable 1: Revenue\nQ1\tQ2\n100\t200",
            "Table 2: Costs\nRent",
            "Price 10 8 old",
            "山路(やまみち)を歩く。東京（とうきょう）に着く。川を見る。海(うみ) まで。",
            "## Chapter 3",
          ],
          absent: [
            "My Novel",
            "Hidden Author",
            "Draft note",
            "Hidden block",
            "Hidden nested",
            "Hidden image text",
            "Display none image",
            "Invisible image",
            "Root hidden",
          ],
        },
      ];
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
      const progressPath = NodePath.join(config.attachmentsDir, "progress.ipynb");
      NodeFS.writeFileSync(
        progressPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              source: "train()",
              outputs: [
                {
                  output_type: "stream",
                  name: "stderr",
                  text: [`${"  1%|#               |\r".repeat(50_000)}100%|################|\n`],
                },
              ],
            },
            { cell_type: "markdown", source: "Later cell survived" },
          ],
        }),
      );
      const progressExtracted = yield* Effect.promise(() =>
        extractDocumentText(progressPath, ".ipynb"),
      );
      expect(progressExtracted).toContain("100%|################|");
      expect(progressExtracted).not.toContain("1%|#");
      expect(progressExtracted).toContain("Later cell survived");
      expect(progressExtracted).not.toContain("[Extracted text truncated");
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
      NodeFS.writeFileSync(unsupportedPath, String.raw`{\rtf1\ansi\ansicpg99999 \'82\'a0}`);
      yield* Effect.promise(async () => {
        await expect(extractDocumentText(unsupportedPath, ".rtf")).rejects.toThrow(
          "Unsupported RTF code page",
        );
      });
      expect(yield* (yield* DocumentText.DocumentText).ensure(unsupportedPath)).toBeUndefined();
      expect(NodeFS.existsSync(unsupportedPath + ".txt")).toBe(false);
      NodeFS.writeFileSync(
        path,
        String.raw`{\rtf1 ` + "x".repeat(999_999) + String.raw`\u-10179?\u-8576? After}`,
      );
      const unicodeTruncated = yield* Effect.promise(() => extractDocumentText(path, ".rtf"));
      expect(unicodeTruncated).toContain("[Extracted text truncated");
      expect(unicodeTruncated.isWellFormed()).toBe(true);
      expect(unicodeTruncated.startsWith("x".repeat(999_999))).toBe(true);
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
  it.effect("keeps selected values intact and appends an actual readable server path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${attachment.id}.txt`);
      NodeFS.writeFileSync(path, "spec");
      const original = { q: ["First", "Second"], other: "No file" };
      const answers = yield* appendUserInputAttachmentPaths({
        answers: original,
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      });
      expect(answers.q).toEqual([
        "First",
        "Second",
        `Attached file "spec \\"final\\".txt": ${JSON.stringify(path)}`,
      ]);
      expect(answers.other).toBe("No file");
      expect(original.q).toEqual(["First", "Second"]);
      expect(NodeFS.readFileSync(path, "utf8")).toBe("spec");
      const specialKey = yield* appendUserInputAttachmentPaths({
        answers: {},
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { ["__proto__"]: [attachment] },
      });
      expect(Object.keys(specialKey)).toEqual(["__proto__"]);
      expect(specialKey["__proto__"]).toContain(JSON.stringify(path));
    }).pipe(Effect.provide(layer)),
  );
  it.effect("does not send an unavailable attachment path", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const result = yield* appendUserInputAttachmentPaths({
        answers: { q: "" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [attachment] },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(layer)),
  );
});
