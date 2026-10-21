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
  it.effect("keeps unrelated files and cached text available during document extraction", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = NodePath.join(config.attachmentsDir, "blocked.rtf");
      const cached = NodePath.join(config.attachmentsDir, "cached.rtf");
      NodeFS.writeFileSync(path, String.raw`{\rtf1 Available}`);
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
        expect(yield* Fiber.join(extraction)).toBe(path + ".txt");
        expect(yield* Fiber.join(duplicate)).toBe(path + ".txt");
        expect(reads).toBe(1);
        expect(NodeFS.readFileSync(path + ".txt", "utf8")).toBe("Available");
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
            outputs: [{ text: ["301\n"] }, { data: { "text/plain": ["42"] } }],
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

  it.effect("preserves office structure and EPUB reading order with bounded archives", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cases = [
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
                    '<presentation><sldId r:id="bad"/><sldId r:id="good"/></presentation>',
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
            "word/document.xml":
              '<w:document xmlns:w="urn:w"><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Report &amp; totals</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p><w:p><w:r><w:t>34</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Before</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>After</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Neighbor</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
          },
          expected: ["## Report & totals", "North\t12 34", "Before Inner After\tNeighbor"],
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
          parts: {
            "xl/workbook.xml":
              '<workbook><sheets><sheet name="Inventory" r:id="a"/><sheet name="Budget" r:id="b"/></sheets></workbook>',
            "xl/_rels/workbook.xml.rels":
              '<Relationships><Relationship Id="a" Target="worksheets/second.xml"/><Relationship Id="b" Target="worksheets/first.xml"/></Relationships>',
            "xl/sharedStrings.xml": "<sst><si><t>Lantern</t></si></sst>",
            "xl/styles.xml":
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
            "ppt/presentation.xml":
              '<p:presentation><p:sldIdLst><p:sldId id="1" r:id="b"/><p:sldId id="2" r:id="a"/></p:sldIdLst></p:presentation>',
            "ppt/_rels/presentation.xml.rels":
              '<Relationships><Relationship Id="a" Target="slides/slide1.xml"/><Relationship Id="b" Target="slides/slide2.xml"/></Relationships>',
            "ppt/slides/slide1.xml": "<p:sld><a:p><a:r><a:t>Departure</a:t></a:r></a:p></p:sld>",
            "ppt/slides/slide2.xml": "<p:sld><a:p><a:r><a:t>Juniper Pier</a:t></a:r></a:p></p:sld>",
            "ppt/slides/_rels/slide2.xml.rels":
              '<Relationships><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../notesSlides/ignored.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" TargetMode="External" Target="https://example.com/notes.xml"/><Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notes7.xml"/></Relationships>',
            "ppt/slides/_rels/slide1.xml.rels":
              '<Relationships><Relationship Type="http://purl.oclc.org/ooxml/officeDocument/relationships/notesSlide" Target="/ppt/notesSlides/notes3.xml"/></Relationships>',
            "ppt/notesSlides/notes7.xml":
              "<p:notes><a:p><a:r><a:t>evacuation code ORCHID-81</a:t></a:r></a:p></p:notes>",
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
          absent: ["Unrelated notes", "[Skipped document part", "[Extracted text truncated"],
        },
        ...[false, true].map((missing) => ({
          ext: "pptx",
          bounded: true,
          parts: {
            "ppt/presentation.xml": '<presentation><sldId r:id="a"/></presentation>',
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
              '<presentation><sldId r:id="a"/><sldId r:id="b"/></presentation>',
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
              '<office:document><text:h text:outline-level="2">Orchard</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates</text:p></office:document>',
          },
          expected: ["## Orchard", "19   violet crates"],
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
              "<office:document><draw:page><text:p>First</text:p></draw:page><draw:page><text:p>Second</text:p></draw:page></office:document>",
          },
          expected: ["## Slide 1", "First", "## Slide 2", "Second"],
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
              '<p:presentation><p:sldId r:id="a"/><p:sldId r:id="missing"/></p:presentation>',
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
              '<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>',
            "OEBPS/a.xhtml":
              '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html><body><p>Last chapter</p><p>Price <s>10</s> 8</p></body></html>',
            "OEBPS/b.xhtml":
              "<!DOCTYPE html><html><body><h1>First chapter</h1><p>Larkspur</p><div>Direct div<section>Direct section<li>Direct item <em>emphasis</em> trailing</li></section></div><div>Account: A<br/>Balance: 731<line-break/>Currency: USD</div><table><thead><tr><th>Heading</th><th>Total</th></tr></thead><tbody><tr><td>Important value</td><td>731</td></tr><tr><td>Before<table><tr><td>Inner</td></tr></table>After</td><td>Neighbor</td></tr></tbody></table></body></html>",
          },
          expected: [
            "## Chapter 1",
            "# First chapter",
            "Larkspur",
            "Direct div",
            "Direct section",
            "Direct item emphasis trailing",
            "Account: A\nBalance: 731\nCurrency: USD",
            "Heading\tTotal",
            "Important value\t731",
            "Before Inner After\tNeighbor",
            "## Chapter 2",
            "Last chapter",
            "Price 10 8",
          ],
        },
      ];
      for (const [caseIndex, item] of cases.entries()) {
        const local: Buffer[] = [];
        const central: Buffer[] = [];
        let offset = 0;
        for (const [name, content] of Object.entries(item.parts)) {
          const data = Buffer.from(content!);
          const filename = Buffer.from(name);
          const header = Buffer.alloc(30);
          header.writeUInt32LE(0x04034b50);
          header.writeUInt16LE(20, 4);
          header.writeUInt32LE(NodeZlib.crc32(data), 14);
          header.writeUInt32LE(data.length, 18);
          header.writeUInt32LE(data.length, 22);
          header.writeUInt16LE(filename.length, 26);
          const directory = Buffer.alloc(46);
          directory.writeUInt32LE(0x02014b50);
          directory.writeUInt16LE(20, 4);
          directory.writeUInt16LE(20, 6);
          directory.writeUInt32LE(NodeZlib.crc32(data), 16);
          directory.writeUInt32LE(data.length, 20);
          directory.writeUInt32LE(data.length, 24);
          directory.writeUInt16LE(filename.length, 28);
          directory.writeUInt32LE(offset, 42);
          local.push(header, filename, data);
          central.push(directory, filename);
          offset += header.length + filename.length + data.length;
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
        `Attached file "spec \\"final\\".txt": "${path}"`,
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
      expect(specialKey["__proto__"]).toContain(path);
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
