// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";

import {
  hermesHistoryMediaRoots,
  normalizeHermesHistoryMessage,
  parseHermesHistoryText,
  persistHermesHistoryMedia,
} from "./HermesHistoryNormalization.ts";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MP4_BYTES = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);

describe("Hermes imported history normalization", () => {
  it("parses the installed sender, image-path, and screenshot persistence envelope", () => {
    const path = "/Users/maria/.hermes/cache/images/img_c2f562760fbb.webp";
    expect(
      parseHermesHistoryText({
        role: "user",
        text: `[maria] rewrite better\n\n[Image attached at: ${path}]\n[screenshot]`,
      }),
    ).toEqual({
      text: "rewrite better",
      media: [{ kind: "image", path }],
    });
  });

  it("preserves assistant text, reply envelopes, multiline content, and ordinary bracketed prose", () => {
    const reply = ['[Replying to: "earlier message"]', "keep this", "and this"].join("\n");
    expect(parseHermesHistoryText({ role: "user", text: reply })).toEqual({
      text: reply,
      media: [],
    });
    expect(parseHermesHistoryText({ role: "user", text: "[Important] keep this" }).text).toBe(
      "[Important] keep this",
    );
    expect(parseHermesHistoryText({ role: "assistant", text: "[maria] assistant text" }).text).toBe(
      "[maria] assistant text",
    );
    expect(
      parseHermesHistoryText({
        role: "user",
        text: "[maria|transport-user-id]\nfirst line\nsecond line",
      }).text,
    ).toBe("first line\nsecond line");
    expect(
      parseHermesHistoryText({
        role: "user",
        text: "[Summary]\nfirst line\nsecond line",
      }).text,
    ).toBe("[Summary]\nfirst line\nsecond line");
  });

  it("extracts upstream MEDIA directives from labeled assistant output", () => {
    const root = "/Users/maria/Downloads/kimi-thumbnail-renditions";
    expect(
      parseHermesHistoryText({
        role: "assistant",
        text: [
          "Made 3 renditions.",
          "",
          `1. **Wall quote** MEDIA:${root}/01-wall-quote.jpg`,
          `2. **Bottom-right** MEDIA:${root}/02-bottom-right.jpg`,
          `**Comparison sheet** MEDIA:${root}/comparison-sheet.jpg`,
        ].join("\n"),
      }),
    ).toEqual({
      text: [
        "Made 3 renditions.",
        "",
        "1. **Wall quote**",
        "2. **Bottom-right**",
        "**Comparison sheet**",
      ].join("\n"),
      media: [
        { kind: "image", path: `${root}/01-wall-quote.jpg` },
        { kind: "image", path: `${root}/02-bottom-right.jpg` },
        { kind: "image", path: `${root}/comparison-sheet.jpg` },
      ],
    });
  });

  it("captures two MEDIA directives on one line separately", () => {
    expect(
      parseHermesHistoryText({
        role: "assistant",
        text: "Before MEDIA:/tmp/media one.png MEDIA:/tmp/media two.png after",
      }),
    ).toEqual({
      text: "Before   after",
      media: [
        { kind: "image", path: "/tmp/media one.png" },
        { kind: "image", path: "/tmp/media two.png" },
      ],
    });
    expect(
      parseHermesHistoryText({
        role: "assistant",
        text: "MEDIA:/tmp/no-extension MEDIA:/tmp/real.png",
      }),
    ).toEqual({
      text: "",
      media: [
        { kind: "image", path: "/tmp/real.png" },
        { kind: "file", path: "/tmp/no-extension" },
      ],
    });
  });

  it("honors quoted MEDIA paths and preserves examples in protected prose", () => {
    const real = "/Users/maria/Downloads/rendered output/report.pdf";
    const text = [
      `Report MEDIA:"${real}"`,
      "Use `MEDIA:/tmp/example.png` to attach an image.",
      "> Example: MEDIA:/tmp/quoted.png",
      "```text",
      "MEDIA:/tmp/fenced.png",
      "```",
      'log: {"old":"MEDIA:/tmp/stale.png"}',
    ].join("\n");
    expect(parseHermesHistoryText({ role: "assistant", text })).toEqual({
      text: [
        "Report",
        "Use `MEDIA:/tmp/example.png` to attach an image.",
        "> Example: MEDIA:/tmp/quoted.png",
        "```text",
        "MEDIA:/tmp/fenced.png",
        "```",
        'log: {"old":"MEDIA:/tmp/stale.png"}',
      ].join("\n"),
      media: [{ kind: "file", path: real }],
    });
    expect(
      parseHermesHistoryText({
        role: "user",
        text: "Please explain MEDIA:/tmp/not-a-user-attachment.png",
      }),
    ).toEqual({
      text: "Please explain MEDIA:/tmp/not-a-user-attachment.png",
      media: [],
    });
  });

  it("uses a safe placeholder when a screenshot has no recoverable media reference", () => {
    expect(parseHermesHistoryText({ role: "user", text: "[maria] \n[screenshot]" }).text).toBe(
      "[Image unavailable]",
    );
  });

  it("defaults to Hermes-owned media locations, not general user or temporary directories", () => {
    const hermesHome = NodePath.join(NodePath.sep, "tmp", "hermes-profile");
    const roots = hermesHistoryMediaRoots({ hermesHome, profileKey: "default" });

    expect(roots).toContain(NodePath.join(hermesHome, "cache", "images"));
    expect(roots).toContain(NodePath.join(hermesHome, "cache", "videos"));
    expect(roots).toContain(NodePath.join(hermesHome, "cache", "screenshots"));
    expect(roots).toContain(NodePath.join(hermesHome, "image_cache"));
    expect(roots).not.toContain(NodePath.join(hermesHome, "cache"));
    expect(roots).not.toContain(NodeOS.tmpdir());
    expect(roots).not.toContain(NodePath.join(NodeOS.homedir(), "Desktop"));
    expect(roots).not.toContain(NodePath.join(NodeOS.homedir(), "Documents"));
    expect(roots).not.toContain(NodePath.join(NodeOS.homedir(), "Downloads"));
  });

  it("expands a tilde-prefixed hermes home into the user home directory", () => {
    const roots = hermesHistoryMediaRoots({
      hermesHome: `~${NodePath.sep}.hermes`,
      profileKey: "default",
    });

    expect(roots).toContain(NodePath.join(NodeOS.homedir(), ".hermes", "cache", "images"));
    expect(roots).not.toContain(NodePath.resolve(`~${NodePath.sep}.hermes`, "cache", "images"));
  });

  effectIt.effect(
    "allows Hermes cache media and denies arbitrary user files, traversal, and symlink escapes",
    () =>
      Effect.gen(function* () {
        const temp = yield* Effect.sync(() =>
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-history-")),
        );
        return yield* Effect.gen(function* () {
          const hermesHome = NodePath.join(temp, "profile");
          const cache = NodePath.join(hermesHome, "cache", "images");
          const attachmentsDir = NodePath.join(temp, "t3", "attachments");
          const outside = NodePath.join(temp, "outside.png");
          const image = NodePath.join(cache, "img_fixture.webp");
          const video = NodePath.join(hermesHome, "cache", "videos", "clip.mp4");
          const desktop = NodePath.join(temp, "Desktop", "predictable.png");
          const documents = NodePath.join(temp, "Documents", "predictable.png");
          const downloads = NodePath.join(temp, "Downloads", "predictable.png");
          const arbitraryTemp = NodePath.join(temp, "predictable-tmp.png");
          const traversal = `${cache}${NodePath.sep}..${NodePath.sep}..${NodePath.sep}..${NodePath.sep}outside.png`;
          const unsupported = NodePath.join(cache, "not-media.txt");
          const oversized = NodePath.join(cache, "oversized.png");
          const symlink = NodePath.join(cache, "escaped.webp");
          NodeFS.mkdirSync(cache, { recursive: true });
          NodeFS.mkdirSync(NodePath.dirname(video), { recursive: true });
          NodeFS.mkdirSync(NodePath.dirname(desktop), { recursive: true });
          NodeFS.mkdirSync(NodePath.dirname(documents), { recursive: true });
          NodeFS.mkdirSync(NodePath.dirname(downloads), { recursive: true });
          NodeFS.writeFileSync(image, PNG_BYTES);
          NodeFS.writeFileSync(video, MP4_BYTES);
          NodeFS.writeFileSync(outside, PNG_BYTES);
          NodeFS.writeFileSync(desktop, PNG_BYTES);
          NodeFS.writeFileSync(documents, PNG_BYTES);
          NodeFS.writeFileSync(downloads, PNG_BYTES);
          NodeFS.writeFileSync(arbitraryTemp, PNG_BYTES);
          NodeFS.writeFileSync(unsupported, "not media");
          NodeFS.writeFileSync(oversized, PNG_BYTES);
          NodeFS.truncateSync(oversized, 20 * 1024 * 1024 + 1);
          NodeFS.symlinkSync(outside, symlink);

          const persist = (sourcePath: string, expectedKind: "image" | "video" = "image") =>
            persistHermesHistoryMedia({
              sourcePath,
              expectedKind,
              approvedRoots: hermesHistoryMediaRoots({
                hermesHome,
                profileKey: "default",
              }),
              attachmentsDir,
              threadId: "thread:hermes:imported",
              stableKey: "history-message-1:0",
            });
          const first = yield* persist(image);
          NodeFS.unlinkSync(image);
          const replay = yield* persist(image);

          expect(first).toMatchObject({
            type: "image",
            name: "img_fixture.webp",
            mimeType: "image/png",
            sizeBytes: PNG_BYTES.byteLength,
          });
          expect(yield* persist(video, "video")).toMatchObject({
            type: "video",
            name: "clip.mp4",
            mimeType: "video/mp4",
            sizeBytes: MP4_BYTES.byteLength,
          });
          expect(replay).toEqual(first);
          expect(NodeFS.readdirSync(attachmentsDir)).toHaveLength(2);
          expect(yield* persist(outside)).toBeNull();
          expect(yield* persist(desktop)).toBeNull();
          expect(yield* persist(documents)).toBeNull();
          expect(yield* persist(downloads)).toBeNull();
          expect(yield* persist(arbitraryTemp)).toBeNull();
          expect(yield* persist(traversal)).toBeNull();
          expect(yield* persist(symlink)).toBeNull();
          expect(yield* persist(unsupported)).toBeNull();
          expect(yield* persist(oversized)).toBeNull();
        }).pipe(
          Effect.ensuring(Effect.sync(() => NodeFS.rmSync(temp, { recursive: true, force: true }))),
        );
      }),
  );

  effectIt.effect("persists an approved generated PDF and generic document", () =>
    Effect.gen(function* () {
      const temp = yield* Effect.sync(() =>
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-hermes-media-output-")),
      );
      return yield* Effect.gen(function* () {
        const output = NodePath.join(temp, "output");
        const attachmentsDir = NodePath.join(temp, "attachments");
        const pdf = NodePath.join(output, "report.pdf");
        const markdown = NodePath.join(output, "notes.md");
        NodeFS.mkdirSync(output, { recursive: true });
        NodeFS.writeFileSync(pdf, "%PDF-1.7\nfixture");
        NodeFS.writeFileSync(markdown, "# Fixture\n");
        const approvedRoots = hermesHistoryMediaRoots({
          hermesHome: NodePath.join(temp, "hermes"),
          profileKey: "default",
          extraRoots: [output],
        });
        const persist = (sourcePath: string, stableKey: string) =>
          persistHermesHistoryMedia({
            sourcePath,
            expectedKind: "file",
            approvedRoots,
            attachmentsDir,
            threadId: "thread:hermes:media-output",
            stableKey,
          });

        expect(yield* persist(pdf, "pdf")).toMatchObject({
          type: "pdf",
          mimeType: "application/pdf",
          name: "report.pdf",
        });
        expect(yield* persist(markdown, "markdown")).toMatchObject({
          type: "file",
          mimeType: "text/markdown",
          name: "notes.md",
        });
      }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(temp, { recursive: true, force: true }))),
      );
    }),
  );

  effectIt.effect("degrades missing media without leaking its path", () =>
    Effect.gen(function* () {
      const rawPath = "/Users/maria/.hermes/cache/images/missing-secret.webp";
      const result = yield* normalizeHermesHistoryMessage({
        role: "user",
        text: `[maria] see this\n[Image attached at: ${rawPath}]\n[screenshot]`,
        resolveMedia: () => Effect.succeed(null),
      });
      expect(result).toEqual({ text: "see this\n\n[Image unavailable]", attachments: [] });
      expect(result.text).not.toContain(rawPath);
    }),
  );

  effectIt.effect("hides an unsupported assistant MEDIA path and degrades safely", () =>
    Effect.gen(function* () {
      const rawPath = "/Users/maria/Downloads/generated/Caddyfile";
      const result = yield* normalizeHermesHistoryMessage({
        role: "assistant",
        text: `Generated the configuration.\nMEDIA:${rawPath}`,
        resolveMedia: () => Effect.succeed(null),
      });
      expect(result).toEqual({
        text: "Generated the configuration.\n\n[File unavailable]",
        attachments: [],
      });
      expect(result.text).not.toContain(rawPath);
    }),
  );
});
