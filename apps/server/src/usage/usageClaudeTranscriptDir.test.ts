// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  isClaudeHomeExplicitOverride,
  resolveClaudeTranscriptDirPath,
} from "./usageClaudeTranscriptDir.ts";

function resolve(input: {
  homePath: string;
  nestedProjectsExists: boolean;
  homeIsExplicitOverride: boolean;
}): string {
  return resolveClaudeTranscriptDirPath({
    ...input,
    join: NodePath.join,
  });
}

describe("resolveClaudeTranscriptDirPath", () => {
  it("keeps the default home on ~/.claude/projects when the nested dir is missing", () => {
    const homePath = "/Users/alice";
    const resolved = resolve({
      homePath,
      nestedProjectsExists: false,
      homeIsExplicitOverride: false,
    });

    expect(resolved).toBe(NodePath.join(homePath, ".claude", "projects"));
    expect(resolved).not.toBe(NodePath.join(homePath, "projects"));
  });

  it("uses ~/.claude/projects when it exists on the default home", () => {
    const homePath = "/Users/alice";
    expect(
      resolve({
        homePath,
        nestedProjectsExists: true,
        homeIsExplicitOverride: false,
      }),
    ).toBe(NodePath.join(homePath, ".claude", "projects"));
  });

  it("uses <override>/projects when a custom home has no nested projects dir", () => {
    const homePath = "/opt/claude-config";
    expect(
      resolve({
        homePath,
        nestedProjectsExists: false,
        homeIsExplicitOverride: true,
      }),
    ).toBe(NodePath.join(homePath, "projects"));
  });

  it("prefers <override>/.claude/projects when a custom home nests the same way", () => {
    const homePath = "/opt/claude-config";
    expect(
      resolve({
        homePath,
        nestedProjectsExists: true,
        homeIsExplicitOverride: true,
      }),
    ).toBe(NodePath.join(homePath, ".claude", "projects"));
  });

  it("treats empty or whitespace configured homePath as the default, not an override", () => {
    const homePath = "/Users/alice";
    for (const configured of ["", "   ", "\t", "\n", " \t\n "]) {
      expect(isClaudeHomeExplicitOverride(configured)).toBe(false);
      expect(
        resolve({
          homePath,
          nestedProjectsExists: false,
          homeIsExplicitOverride: isClaudeHomeExplicitOverride(configured),
        }),
      ).toBe(NodePath.join(homePath, ".claude", "projects"));
    }
  });
});

describe("isClaudeHomeExplicitOverride", () => {
  it("is true only when the configured homePath is non-empty after trim", () => {
    expect(isClaudeHomeExplicitOverride("~/.claude-work")).toBe(true);
    expect(isClaudeHomeExplicitOverride("  /custom/claude  ")).toBe(true);
    expect(isClaudeHomeExplicitOverride("")).toBe(false);
    expect(isClaudeHomeExplicitOverride("   ")).toBe(false);
  });
});
