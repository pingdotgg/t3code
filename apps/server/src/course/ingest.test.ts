// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";
import * as ProcessRunner from "../processRunner.ts";

import {
  captionToText,
  ingestCourse,
  json3ToText,
  parseOcwZip,
  parseOcwZipEntries,
  transcriptWindow,
} from "./ingest.ts";

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const oneEntryZip = (name: string, data: Uint8Array) => {
  const nameBytes = Buffer.from(name);
  const compressed = NodeZlib.deflateRawSync(data);
  const crc = crc32(data);
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);
  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length + compressed.length, 16);
  return Buffer.concat([local, compressed, central, end]);
};

describe("course ingestion parsers", () => {
  it("turns VTT and SRT cues into 30-second lines and removes rolling captions", () => {
    const vtt = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHello <c.green>world</c>\n\n00:00:05.000 --> 00:00:08.000\nHello world again\n\n00:31.000 --> 00:00:34.000\nNext cue`;
    expect(captionToText(vtt)).toBe("[00:00] Hello world again\n[00:30] Next cue");
    expect(
      captionToText(
        "1\n00:00:00,000 --> 00:00:01,000\nOne\n\n2\n00:00:31,000 --> 00:00:32,000\nTwo",
      ),
    ).toBe("[00:00] One\n[00:30] Two");
  });

  it("turns json3 events into timestamped lines", () => {
    const raw = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: "A" }] },
        { tStartMs: 31_000, segs: [{ utf8: "B" }] },
      ],
    });
    expect(json3ToText(raw)).toBe("[00:00] A\n[00:30] B");
  });

  it("selects transcript lines inside inclusive edges and leaves plain text unchanged", () => {
    const text = "[00:00] zero\n[00:30] thirty\n[01:00] sixty";
    expect(transcriptWindow(text, 30, 30)).toBe("[00:00] zero\n[00:30] thirty\n[01:00] sixty");
    expect(transcriptWindow(text, 30, 0)).toBe("[00:30] thirty");
    expect(transcriptWindow("plain transcript", 30, 5)).toBe("plain transcript");
  });

  it("parses video resources and their caption files from OCW entries", () => {
    const entries = new Map<string, string>([
      [
        "data.json",
        JSON.stringify({
          title: "Course Metadata",
          course_title: "Tiny Linear Algebra",
          primary_course_number: "18.06",
        }),
      ],
      [
        "video_galleries/video-lectures/data.json",
        JSON.stringify({ videos: [{ uid: "u1" }, { uid: "u2" }] }),
      ],
      [
        "resources/a/data.json",
        JSON.stringify({ resourcetype: "Video", uid: "u2", title: "Lecture 2" }),
      ],
      [
        "resources/b/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "u1",
          title: "Lecture 1",
          license: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
          video_metadata: { youtube_id: "abc" },
          video_files: JSON.stringify({ video_captions_resources: [{ file: "cap.vtt" }] }),
        }),
      ],
      ["static_resources/cap.vtt", "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nVectors"],
      ["resources/2/data.json", JSON.stringify({ resourcetype: "PDF", title: "Reading" })],
      [
        "pages/week/data.json",
        JSON.stringify({
          title: "Week 1",
          content: '<a href="../../resources/pset/index.html">Pset</a>',
        }),
      ],
      [
        "pages/assignments/data.json",
        JSON.stringify({
          title: "Assignments",
          content:
            '<tr><td><a href="../../resources/pset/index.html">Pset</a></td><td><a href="../../pages/first/child/index.html">Lecture 1</a></td></tr>',
        }),
      ],
      [
        "resources/pset/data.json",
        JSON.stringify({
          resourcetype: "Document",
          title: "Problem Set 1",
          learning_resource_types: ["Assignments"],
          file: "/courses/tiny/pset.pdf",
        }),
      ],
      [
        "resources/solution/data.json",
        JSON.stringify({
          resourcetype: "Document",
          title: "Problem Set 1 Solution",
          learning_resource_types: ["Problem Set Solutions"],
          file: "/courses/tiny/solution.pdf",
        }),
      ],
      ["pages/week/index.html", ""],
      ["index.html", '<a href="pages/week/index.html">Week 1</a>'],
    ]);
    const course = parseOcwZipEntries(
      entries,
      "https://ocw.mit.edu/courses/tiny/",
      new Map([
        ["pset.pdf", "problem text"],
        ["solution.pdf", "solution text"],
      ]),
    );
    expect(course.title).toBe("18.06 Tiny Linear Algebra");
    expect(course.units).toEqual([
      { title: "Lecture 1", youtubeId: "abc", text: "[00:00] Vectors" },
      { title: "Lecture 2" },
    ]);
    expect(course.attribution).toContain("CC BY-NC-SA 4.0");
    expect(course.problemSets?.[0]).toMatchObject({
      title: "Problem Set 1",
      text: "problem text",
      solution: "solution text",
      section: "Week 1",
    });
  });

  it("orders OCW videos by section and child page order without a gallery", () => {
    const entries = new Map<string, string>([
      ["course/pages/second/index.html", '<a href="pages/second/">Wrong index</a>'],
      [
        "course/index.html",
        '<a href="./pages/first/index.html">First</a><a href="./pages/second/index.html">Second</a><a href="./pages/week/index.html">Week</a><a href="./pages/first/index.html">Again</a>',
      ],
      ["course/pages/second/child/data.json", JSON.stringify({ title: "Second child" })],
      [
        "course/pages/second/data.json",
        JSON.stringify({
          title: "Second",
          content: '<a href="../../pages/second/child/index.html">Child</a>',
        }),
      ],
      [
        "course/pages/first/child/data.json",
        JSON.stringify({
          title: "First child",
          content: '<track src="../../hash_v_5.vtt"><track src="../../hash_v4.vtt">',
        }),
      ],
      [
        "course/pages/first/data.json",
        JSON.stringify({
          title: "First",
          content:
            '<a href="../../pages/second/child/index.html">Other section</a><a href="../../pages/first/child/index.html">Child</a>',
        }),
      ],
      [
        "course/resources/a/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "v3",
          title: "Lecture 3",
          parent_title: "Second child",
        }),
      ],
      [
        "course/resources/b/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "v2",
          title: "Lecture 2",
          parent_title: "First child",
          video_metadata: { youtube_id: "v2" },
        }),
      ],
      [
        "course/resources/c/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "v1",
          title: "Lecture 1",
          parent_title: "First",
          video_metadata: { youtube_id: "v1" },
        }),
      ],
      [
        "course/resources/d/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "v4",
          title: "Lecture 4",
          parent_title: "First child",
          video_metadata: { youtube_id: "v4" },
        }),
      ],
      [
        "course/resources/e/data.json",
        JSON.stringify({
          resourcetype: "Video",
          uid: "v5",
          title: "Lecture 5",
          parent_title: "First child",
          video_metadata: { youtube_id: "v_5" },
        }),
      ],
    ]);
    const titles = () =>
      parseOcwZipEntries(entries, "https://ocw.mit.edu/courses/tiny/").units.map(
        (unit) => unit.title,
      );
    expect(titles()).toEqual(["Lecture 1", "Lecture 5", "Lecture 4", "Lecture 2", "Lecture 3"]);
    entries.set(
      "course/video_galleries/lectures/data.json",
      JSON.stringify({ videos: [{ uid: "v3" }, { uid: "v1" }, { uid: "v2" }] }),
    );
    expect(titles()).toEqual(["Lecture 3", "Lecture 1", "Lecture 2", "Lecture 5", "Lecture 4"]);
  });

  it.effect("uses top-level PDF outline entries as units", () =>
    Effect.gen(function* () {
      const course = yield* ingestCourse(
        NodePath.join(import.meta.dirname, "fixtures/tiny-outline.pdf"),
        { ytDlp: false, workDir: "/tmp" },
      );
      expect(course.title).toBe("Tiny Course");
      expect(course.units.map((unit) => [unit.title, unit.pages, unit.text])).toEqual([
        ["Chapter One", [1, 1], "Chapter One"],
        ["Chapter Two", [2, 2], "Chapter Two"],
      ]);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("not used") }),
    ),
  );

  it.effect("reads a tiny OCW zip fixture through yauzl", () =>
    Effect.gen(function* () {
      const course = yield* parseOcwZip(
        NodePath.join(import.meta.dirname, "fixtures/tiny-ocw.zip"),
        "https://ocw.mit.edu/courses/tiny/",
      );
      expect(course.units.map((unit) => unit.title)).toEqual(["Lecture 0", "Lecture 1"]);
      expect(course.units[0]?.section).toBe("Other");
      expect(course.units[1]?.text).toBe("[00:00] Tiny caption");
      expect(course.problemSets?.map((pset) => [pset.title, pset.text, pset.solution])).toEqual([
        ["PS 1", "Chapter One\n\nChapter Two", "Chapter One\n\nChapter Two"],
        ["Problem Set 2", "Chapter One\n\nChapter Two", undefined],
      ]);
      expect(course.problemSets?.[0]?.workedExampleUnits).toEqual([1]);
    }),
  );

  it.effect("skips an OCW entry over the uncompressed member limit", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ocw-")),
      );
      const zipPath = NodePath.join(directory, "bomb.zip");
      const data = Buffer.from(
        JSON.stringify({
          resourcetype: "Video",
          title: "Bomb",
          padding: "x".repeat(20 * 1024 * 1024),
        }),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(zipPath, oneEntryZip("resources/a/data.json", data)),
      );
      const course = yield* parseOcwZip(zipPath, "https://ocw.mit.edu/courses/bomb/");
      expect(course.units).toEqual([]);
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  it.effect("keeps the course when a problem-set PDF can't be read", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-ocw-")),
      );
      const zipPath = NodePath.join(directory, "broken.zip");
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          zipPath,
          oneEntryZip("static_resources/x_pset1.pdf", Buffer.from("not a pdf")),
        ),
      );
      const course = yield* parseOcwZip(zipPath, "https://ocw.mit.edu/courses/broken/");
      expect(course.problemSets).toBeUndefined();
      yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    }),
  );

  it.effect("refuses an OCW download page that points the zip off OCW", () =>
    Effect.gen(function* () {
      using _fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response('<a href="https://evil.example/course.zip">zip</a>'));
      const error = yield* ingestCourse("https://ocw.mit.edu/courses/tiny/", {
        ytDlp: false,
        workDir: "/tmp",
      }).pipe(Effect.flip);
      expect(error.message).toContain("is not MIT OpenCourseWare");
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("not used") }),
    ),
  );

  it.effect("audits the OCW download page with its bytes and hash", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ocw-audit-")),
      );
      const html = "<html>no course zip here</html>";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(html, { headers: { "content-type": "text/html" } })),
      );
      const result = yield* ingestCourse("https://ocw.mit.edu/courses/tiny/", {
        ytDlp: false,
        workDir: NodePath.join(stateDir, "tmp"),
        audit: { stateDir, threadId: "lesson-1", courseId: null },
      }).pipe(Effect.flip, Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
      expect(result.message).toContain("did not contain a course zip");
      const [file] = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(stateDir, "audit")));
      const lines = (yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(stateDir, "audit", file!), "utf8"),
      ))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        url: "https://ocw.mit.edu/courses/tiny/download/",
        status: 200,
        bytes: Buffer.byteLength(html),
        threadId: "lesson-1",
      });
      expect(lines[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("not used") }),
    ),
  );

  it.effect("audits one failed OCW hop once", () =>
    Effect.gen(function* () {
      const stateDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ocw-audit-failure-")),
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Promise.reject(new Error("socket closed"))),
      );
      yield* ingestCourse("https://ocw.mit.edu/courses/tiny/", {
        ytDlp: false,
        workDir: NodePath.join(stateDir, "tmp"),
        audit: { stateDir },
      }).pipe(Effect.flip, Effect.ensuring(Effect.sync(() => vi.unstubAllGlobals())));
      const [file] = yield* Effect.promise(() => NodeFSP.readdir(NodePath.join(stateDir, "audit")));
      const lines = (yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(stateDir, "audit", file!), "utf8"),
      ))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("socket closed");
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run: () => Effect.die("not used") }),
    ),
  );
});
