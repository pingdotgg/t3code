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
      "text symbol fallback",
      String.raw`{\rtf1\ansi\uc10\u945\endash\emdash\enspace\emspace\qmspace\lquote\rquote\ldblquote\rdblquote\bullet Z}`,
      "αZ",
    ],
    ["hyphen symbol fallback", String.raw`{\rtf1\ansi\uc3\u945\~\_\-Z}`, "αZ"],
    ["control word", String.raw`{\rtf1\ansi A\u9\tab X}`, "A\tX"],
    ["group close", String.raw`{\rtf1\ansi{\u945}Z}`, "αZ"],
    ["group open", String.raw`{\rtf1\ansi\u945{Z}}`, "αZ"],
    ["hex byte", String.raw`{\rtf1\ansi\u945\'3fZ}`, "αZ"],
    ["escaped symbol", String.raw`{\rtf1\ansi\u945\{Z}`, "αZ"],
    ["destination symbol", String.raw`{\rtf1\ansi\u945\*Z}`, "αZ"],
    ["multiple units", String.raw`{\rtf1\ansi\uc4\u945?\tab\'3f\~Z}`, "αZ"],
    ["binary unit", String.raw`{\rtf1\ansi\u945\bin3 abcZ}`, "αZ"],
    ["large fallback", String.raw`{\rtf1\ansi\uc20\u945????????????????????Z}`, "αZ"],
    ["no fallback", String.raw`{\rtf1\ansi\uc0\u945Z}`, "αZ"],
    ["scoped count", String.raw`{\rtf1\ansi{\uc2\u945??}\u946?Z}`, "αβZ"],
  ] as const)("extracts RTF symbols and Unicode fallbacks: %s", ([name, source, expected]) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const path = NodePath.join(config.attachmentsDir, `${name}.rtf`);
      NodeFS.writeFileSync(path, source);
      expect(yield* Effect.promise(() => extractDocumentText(path, ".rtf"))).toBe(expected);
      expect(yield* (yield* DocumentText.DocumentText).ensure(path)).toBe(path + ".txt");
      expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe(expected);
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
      const notebook = JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["# Survey\n", "Vessel: Larkspur"] },
          {
            cell_type: "code",
            source: ["print(43 * 7)"],
            outputs: [
              { text: ["301\n"] },
              { data: { "text/plain": ["42"] } },
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
        ],
      });
      NodeFS.writeFileSync(path, notebook);
      const answers = yield* appendUserInputAttachmentPaths({
        answers: { q: "Read this" },
        attachmentsDir: config.attachmentsDir,
        attachmentsByQuestionId: { q: [file] },
      });
      expect(answers.q).toContain(`text extracted to: "${path}.txt"`);
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("Vessel: Larkspur");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("301");
      expect(NodeFS.readFileSync(`${path}.txt`, "utf8")).toContain("42");
      const extracted = NodeFS.readFileSync(`${path}.txt`, "utf8");
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
          expect(answers.q).toContain(path);
          expect(answers.q).not.toContain("text extracted");
          expect(NodeFS.existsSync(`${path}.txt`)).toBe(false);
          expect(NodeFS.readFileSync(path, "utf8")).toBe("invalid document");
        }
      }).pipe(Effect.provide(layer)),
  );







});
