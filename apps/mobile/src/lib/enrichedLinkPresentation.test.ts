import { describe, expect, it } from "vite-plus/test";
import type { ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  enrichedLinkVariantPattern,
  enrichedSkillLinkRegex,
  enrichedThreadLinkPresentation,
  ENRICHED_INLINE_FILE_LINK_REGEX,
  threadChipTargets,
} from "./enrichedLinkPresentation";

describe("Enriched link presentation", () => {
  it("recognizes file-shaped code without turning commands or URLs into links", () => {
    for (const path of [
      "src/app.tsx",
      "./README.md",
      "/tmp/report.md",
      "C:\\repo\\app.tsx",
      "app.tsx:12:3",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(path), path).toBe(true);
    }
    for (const text of [
      "npm run dev",
      "port:3000",
      "TODO:12",
      "example.com",
      "https://example.com/app.tsx",
      "x + y",
      "README.md",
      "/app/settings",
    ]) {
      expect(ENRICHED_INLINE_FILE_LINK_REGEX.test(text), text).toBe(false);
    }
  });

  it("only recognizes complete known skill names and escapes their punctuation", () => {
    const regex = enrichedSkillLinkRegex([{ name: "check" }, { name: "check.mobile" }]);
    expect(regex?.exec("Try $check.mobile next")?.[0]).toBe("$check.mobile");
    expect(regex?.exec("Try $check-mobile next")).toBeNull();
    expect(regex?.exec("Try $checkXmobile next")).toBeNull();
    expect(regex?.exec("prefix$check next")).toBeNull();
    expect(enrichedSkillLinkRegex([])).toBeNull();
  });

  it("matches only the complete URL, including literal regex metacharacters", () => {
    const url = "file:///workspace/app[1].tsx?line=3+4";
    const pattern = new RegExp(enrichedLinkVariantPattern(url));
    expect(pattern.test(url)).toBe(true);
    expect(pattern.test(`${url}/child`)).toBe(false);
    expect(pattern.test("file:///workspace/app1Xtsx?line=34")).toBe(false);
  });

  it("presents thread links as thread chips and leaves other links alone", () => {
    for (const href of ["t3-thread://v1/thread%3Aproject%3A1", "t3-thread://v2/env/thread_1"]) {
      expect(enrichedThreadLinkPresentation(href), href).toEqual({
        accent: "#009c96",
        icon: { kind: "chip", name: "messages-square" },
      });
    }
    for (const href of [
      "https://github.com/example/repo/pull/7",
      "https://example.com",
      "t3-context://v1/thread/thread_1",
    ]) {
      expect(enrichedThreadLinkPresentation(href), href).toBeUndefined();
    }
  });

  it("finds each linked thread once and resolves thread records to their own environment", () => {
    const here = "env-here" as EnvironmentId;
    const there = "env-there" as EnvironmentId;
    expect(
      threadChipTargets(
        here,
        "See [A](t3-thread://v1/thread_a), [A again](t3-thread://v1/thread_a), [B](t3-thread://v1/thread_b) and [D](t3-thread://v2/env-there/thread_d).",
        [
          {
            version: 1,
            contextId: "thr1" as ComposerContextId,
            kind: "thread",
            label: "C",
            environmentId: there,
            threadId: "thread_c" as ThreadId,
            title: "C",
          },
        ],
      ),
    ).toEqual([
      { href: "t3-thread://v1/thread_a", environmentId: here, threadId: "thread_a", link: true },
      { href: "t3-thread://v1/thread_b", environmentId: here, threadId: "thread_b", link: true },
      {
        href: "t3-thread://v2/env-there/thread_d",
        environmentId: there,
        threadId: "thread_d",
        link: true,
      },
      {
        href: "t3-context://v1/thread/thr1",
        environmentId: there,
        threadId: "thread_c",
        link: false,
      },
    ]);
    expect(threadChipTargets(here, "No links here.")).toEqual([]);
  });
});
