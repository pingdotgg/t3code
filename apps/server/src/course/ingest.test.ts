// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "node:path";
import * as ProcessRunner from "../processRunner.ts";

import {
  captionToText,
  ingestCourse,
  json3ToText,
  parseOcwZip,
  parseOcwZipEntries,
  transcriptWindow,
} from "./ingest.ts";

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
    ]);
    const course = parseOcwZipEntries(entries, "https://ocw.mit.edu/courses/tiny/");
    expect(course.title).toBe("18.06 Tiny Linear Algebra");
    expect(course.units).toEqual([
      { title: "Lecture 1", youtubeId: "abc", text: "[00:00] Vectors" },
      { title: "Lecture 2" },
    ]);
    expect(course.attribution).toContain("CC BY-NC-SA 4.0");
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
      expect(course.units[0]?.text).toBe("[00:00] Tiny caption");
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
});
