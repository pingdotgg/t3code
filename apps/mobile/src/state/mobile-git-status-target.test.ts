import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isMobileGitInspectorActive,
  resolveMobileGitStatusTarget,
  type MobileGitStatusTargetInput,
} from "./mobile-git-status-target";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");
const baseInput: MobileGitStatusTargetInput = {
  active: true,
  focused: true,
  platform: "ios",
  route: { environmentId: String(environmentId), threadId: String(threadId) },
  selected: { environmentId, threadId, cwd: "/repo/worktree" },
  surface: "thread-route",
};
const remoteTarget = {
  demand: "remote",
  environmentId,
  input: { cwd: "/repo/worktree" },
} as const;
const localTarget = { ...remoteTarget, demand: "local" } as const;

describe("mobile Git status ownership", () => {
  it.each([
    { name: "focused thread route", input: baseInput, expected: remoteTarget },
    {
      name: "blurred thread route",
      input: { ...baseInput, focused: false },
      expected: null,
    },
    {
      name: "Android thread route without status controls",
      input: { ...baseInput, platform: "android" },
      expected: null,
    },
    {
      name: "open Git overview",
      input: { ...baseInput, surface: "git-overview" },
      expected: remoteTarget,
    },
    {
      name: "prewarmed Git overview",
      input: { ...baseInput, active: false, surface: "git-overview" },
      expected: null,
    },
    {
      name: "Git overview after whole-pane close",
      input: { ...baseInput, active: false, surface: "git-overview" },
      expected: null,
    },
    {
      name: "route mismatch",
      input: {
        ...baseInput,
        route: { ...baseInput.route, threadId: "thread-b" },
        surface: "git-overview",
      },
      expected: null,
    },
    {
      name: "environment mismatch",
      input: {
        ...baseInput,
        route: { ...baseInput.route, environmentId: "environment-b" },
        surface: "git-overview",
      },
      expected: null,
    },
    {
      name: "iOS review toolbar",
      input: { ...baseInput, surface: "review" },
      expected: remoteTarget,
    },
    {
      name: "focused Git confirmation",
      input: { ...baseInput, surface: "confirm" },
      expected: remoteTarget,
    },
    {
      name: "blurred Git confirmation",
      input: { ...baseInput, focused: false, surface: "confirm" },
      expected: null,
    },
    {
      name: "Android review without a Git menu",
      input: { ...baseInput, platform: "android", surface: "review" },
      expected: null,
    },
    {
      name: "focused branches sheet",
      input: { ...baseInput, surface: "branches" },
      expected: localTarget,
    },
    {
      name: "focused commit sheet",
      input: { ...baseInput, surface: "commit" },
      expected: localTarget,
    },
    {
      name: "missing selected worktree",
      input: {
        ...baseInput,
        selected: { environmentId, threadId, cwd: null },
        surface: "commit",
      },
      expected: null,
    },
  ] satisfies ReadonlyArray<{
    readonly name: string;
    readonly input: MobileGitStatusTargetInput;
    readonly expected: typeof localTarget | typeof remoteTarget | null;
  }>)("selects demand for $name", ({ input, expected }) => {
    expect(resolveMobileGitStatusTarget(input)).toEqual(expected);
  });

  it.each([
    { name: "open Git inspector", mode: "git", paneVisible: true, expected: true },
    { name: "prewarmed behind Files", mode: "files", paneVisible: true, expected: false },
    { name: "prewarmed behind route content", mode: "route", paneVisible: true, expected: false },
    { name: "closed Git inspector", mode: "git", paneVisible: false, expected: false },
  ] as const)("marks $name active=$expected", ({ expected, mode, paneVisible }) => {
    expect(isMobileGitInspectorActive({ mode, paneVisible })).toBe(expected);
  });

  it("releases an outgoing Git inspector while its inactive portal finishes closing", () => {
    expect(
      isMobileGitInspectorActive({
        mode: "git",
        paneVisible: true,
        registrationActive: false,
      }),
    ).toBe(false);
  });
});
