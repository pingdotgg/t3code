import { describe, expect, it } from "vite-plus/test";

import {
  resolveProjectBooleanSource,
  resolveProjectWorkspaceSource,
  summarizeProjectSettingSources,
} from "./ProjectSettingSource.logic";

describe("project setting sources", () => {
  it("preserves an override that equals the environment default", () => {
    expect(resolveProjectBooleanSource(true, true)).toEqual({ value: true, overridden: true });
    expect(resolveProjectBooleanSource(undefined, true)).toEqual({
      value: true,
      overridden: false,
    });
  });

  it("keeps a disabled override and legacy automatic-pull opt-in", () => {
    expect(resolveProjectBooleanSource(false, true, true)).toEqual({
      value: false,
      overridden: true,
    });
    expect(resolveProjectBooleanSource(undefined, false, true)).toEqual({
      value: true,
      overridden: true,
    });
  });

  it("does not invent a value when the environment is unavailable", () => {
    expect(resolveProjectBooleanSource(undefined, undefined)).toEqual({
      value: undefined,
      overridden: false,
    });
  });

  it("reports partial override coverage independently of equal effective values", () => {
    expect(
      summarizeProjectSettingSources([
        { key: "a", label: "A", value: "On", source: "Project override", overridden: true },
        { key: "b", label: "B", value: "On", source: "Environment default", overridden: false },
      ]),
    ).toBe("1 overridden · 1 inherited");
  });

  it("resolves workspace precedence from project, repository, then environment", () => {
    const input = {
      override: null,
      environmentDefault: "local",
      repositoryDefault: "worktree",
      repositoryResolved: true,
    } as const;
    expect(resolveProjectWorkspaceSource(input)).toEqual({
      value: "worktree",
      source: "t3.json",
      overridden: false,
    });
    expect(resolveProjectWorkspaceSource({ ...input, override: "local" })).toEqual({
      value: "local",
      source: "Project override",
      overridden: true,
    });
    expect(resolveProjectWorkspaceSource({ ...input, repositoryDefault: null })).toEqual({
      value: "local",
      source: "Environment default",
      overridden: false,
    });
  });

  it("does not claim a common inherited workspace before resolving each checkout", () => {
    expect(
      resolveProjectWorkspaceSource({
        override: null,
        environmentDefault: "local",
        repositoryDefault: null,
        repositoryResolved: false,
      }),
    ).toEqual({ value: undefined, source: "t3.json or environment default", overridden: false });
  });

  it("reports unavailable workspace defaults after the repository lookup settles", () => {
    const input = {
      override: null,
      environmentDefault: undefined,
      repositoryDefault: null,
      repositoryResolved: false,
    } as const;
    expect(resolveProjectWorkspaceSource(input)).toEqual({
      value: undefined,
      source: "t3.json or environment default",
      overridden: false,
    });
    expect(resolveProjectWorkspaceSource({ ...input, repositoryResolved: true })).toEqual({
      value: undefined,
      source: "Unavailable",
      overridden: false,
    });
    expect(
      resolveProjectWorkspaceSource({
        ...input,
        repositoryResolved: true,
        environmentDefault: "local",
      }),
    ).toEqual({ value: "local", source: "Environment default", overridden: false });
  });

  it.each([
    {
      override: "local",
      repositoryDefault: "worktree",
      source: "Project override",
      value: "local",
      overridden: true,
    },
    {
      override: null,
      repositoryDefault: "worktree",
      source: "t3.json",
      value: "worktree",
      overridden: false,
    },
  ] as const)(
    "keeps $source available without environment config",
    ({ override, repositoryDefault, source, value, overridden }) => {
      expect(
        resolveProjectWorkspaceSource({
          override,
          environmentDefault: undefined,
          repositoryDefault,
          repositoryResolved: true,
        }),
      ).toEqual({ value, source, overridden });
    },
  );
});
