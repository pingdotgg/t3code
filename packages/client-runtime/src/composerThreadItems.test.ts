import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matchComposerEnvironmentItems,
  matchComposerThreadItems,
  type ComposerThreadCandidate,
} from "./composerThreadItems.ts";

const environmentId = EnvironmentId.make("env-composer");

function shell(
  id: string,
  title: string,
  overrides: Partial<ComposerThreadCandidate> = {},
): ComposerThreadCandidate {
  return {
    environmentId,
    id: ThreadId.make(id),
    title,
    branch: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    opens: null,
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    ...overrides,
  };
}

it("ranks thread mentions like the palette and leaves out subagent threads", () => {
  const items = matchComposerThreadItems({
    shells: [
      shell("newer-mid-word", "Remodel the settings page", {
        updatedAt: "2026-10-20T00:00:00.000Z",
      }),
      shell("word", "Fix model picker"),
      shell("subagent", "Model review", {
        lineage: {
          rootThreadId: ThreadId.make("word"),
          parentThreadId: ThreadId.make("word"),
          relationshipToParent: "subagent",
        },
      }),
      shell("other-environment", "Model docs", { environmentId: EnvironmentId.make("env-other") }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: null,
    query: "model",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map((item) => item.thread.threadId)).toEqual(["word", "newer-mid-word"]);
});

it("offers the composer thread's own used side chats, but not other threads' side chats", () => {
  const sideChatOf = (parent: string) => ({
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "fork" as const,
    sideChat: true,
  });
  const latestUserMessageAt = "2026-10-22T00:00:00.000Z";
  const items = matchComposerThreadItems({
    shells: [
      shell("mine", "Why is the build slow?", { lineage: sideChatOf("main"), latestUserMessageAt }),
      shell("unused", "Slow side chat", { lineage: sideChatOf("main") }),
      shell("theirs", "Why is the test slow?", {
        lineage: sideChatOf("other"),
        latestUserMessageAt,
      }),
    ],
    environmentId,
    linkedEnvironments: new Map(),
    excludeThreadId: ThreadId.make("main"),
    query: "slow",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, description }) => ({ id: thread.threadId, description }))).toEqual([
    { id: "mine", description: "Side chat" },
  ]);
});

it("also offers threads on linked machines, naming the machine, but no other machine's", () => {
  const vps = EnvironmentId.make("env-vps");
  const items = matchComposerThreadItems({
    shells: [
      shell("here", "Deploy script"),
      shell("there", "Deploy script", { environmentId: vps }),
      shell("unlinked", "Deploy notes", { environmentId: EnvironmentId.make("env-unlinked") }),
    ],
    environmentId,
    linkedEnvironments: new Map([[vps, "Hetzner VPS"]]),
    excludeThreadId: null,
    query: "deploy",
    now: Date.parse("2026-10-23T00:00:00.000Z"),
  });
  expect(items.map(({ thread, label, description }) => ({ thread, label, description }))).toEqual([
    { thread: { environmentId, threadId: "here" }, label: "Deploy script", description: "Thread" },
    {
      thread: { environmentId: vps, threadId: "there" },
      label: "Deploy script",
      description: "Thread on Hetzner VPS",
    },
  ]);
});

describe("matchComposerEnvironmentItems", () => {
  const environments = [
    { environmentId: EnvironmentId.make("env-here"), label: "Laptop", machine: "laptop" },
    { environmentId: EnvironmentId.make("env-vps"), label: "Hetzner VPS", machine: "cloud" },
    { environmentId: EnvironmentId.make("env-mini"), label: "Mac mini", machine: "mac-mini" },
  ] as const;

  it("offers the other machines matching the query, never the composer's own", () => {
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "  vps ",
      }),
    ).toEqual([
      {
        id: "environment:env-vps",
        type: "environment",
        environmentId: "env-vps",
        machine: "cloud",
        label: "Hetzner VPS",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "lap",
      }),
    ).toEqual([]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map(),
        environmentId: EnvironmentId.make("env-here"),
        query: "",
      }),
    ).toEqual([]);
  });

  it("offers machines the composer's environment links to that this client is not paired with", () => {
    expect(
      matchComposerEnvironmentItems({
        environments: [],
        linkedEnvironments: new Map([
          [EnvironmentId.make("env-here"), "Laptop"],
          [EnvironmentId.make("env-build"), "buildbox"],
        ]),
        environmentId: EnvironmentId.make("env-here"),
        query: "build",
      }),
    ).toEqual([
      {
        id: "environment:env-build",
        type: "environment",
        environmentId: "env-build",
        machine: "server",
        label: "buildbox",
        description: "Machine",
      },
    ]);
    expect(
      matchComposerEnvironmentItems({
        environments,
        linkedEnvironments: new Map([[EnvironmentId.make("env-vps"), "Hetzner VPS"]]),
        environmentId: EnvironmentId.make("env-here"),
        query: "vps",
      }).map((item) => item.machine),
    ).toEqual(["cloud"]);
  });
});

it("reads dashes, underscores, and dots in a mention as spaces", () => {
  const match = (query: string) =>
    matchComposerThreadItems({
      shells: [
        shell("follow-up", "Review PR 195 follow-up: tests", {
          updatedAt: "2026-10-22T00:00:00.000Z",
        }),
        shell("exact", "Review PR 195"),
        shell("other", "Review PR 194"),
      ],
      environmentId,
      linkedEnvironments: new Map(),
      excludeThreadId: null,
      query,
      now: Date.parse("2026-10-23T00:00:00.000Z"),
    }).map((item) => item.thread.threadId);
  expect(match("review-pr-195")).toEqual(["exact", "follow-up"]);
  expect(match("review_pr.195")).toEqual(["exact", "follow-up"]);
});

it("preserves literal thread ids and punctuation in exact titles", () => {
  const match = (query: string, shells: ReadonlyArray<ComposerThreadCandidate>) =>
    matchComposerThreadItems({
      shells,
      environmentId,
      linkedEnvironments: new Map(),
      excludeThreadId: null,
      query,
      now: Date.parse("2026-10-23T00:00:00.000Z"),
    }).map((item) => item.thread.threadId);
  expect(match("review-pr-195", [shell("review-pr-195", "Unrelated title")])).toEqual([
    "review-pr-195",
  ]);
  expect(
    match("node.js", [
      shell("prefix", "Node.js guide", { updatedAt: "2026-10-22T00:00:00.000Z" }),
      shell("exact", "Node.js"),
    ]),
  ).toEqual(["exact", "prefix"]);
});
