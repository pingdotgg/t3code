import type { SideChatTreeRow } from "@t3tools/client-runtime/state/thread-relationships";
import { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeSideChatThreadFixture, makeThreadFixture } from "../../test-fixtures";
import {
  appendComposerSnippet,
  lessonSideChatWaitLabel,
  shouldFinishSideChatOnClose,
  sideChatAnchorCitation,
  sideChatAwaitingInput,
  sideChatBreadcrumb,
  sideChatComposerStatus,
  sideChatPath,
  sideChatStatusLine,
  sideChatSurfacePath,
  topSideChatId,
} from "./sideChatPanel.logic";

const lessonId = ThreadId.make("lesson-1");
const side1 = ThreadId.make("side-1");
const nested1 = ThreadId.make("nested-1");
const side2 = ThreadId.make("side-2");

const rows: ReadonlyArray<SideChatTreeRow> = [
  {
    threadId: lessonId,
    parentId: null,
    depth: 0,
    label: "Learning RL environments",
    state: "lesson",
    noteStatus: null,
    section: null,
  },
  {
    threadId: side1,
    parentId: lessonId,
    depth: 1,
    label: "observation space",
    state: "open",
    noteStatus: null,
    section: null,
  },
  {
    threadId: nested1,
    parentId: side1,
    depth: 2,
    label: "Box",
    state: "open",
    noteStatus: null,
    section: null,
  },
  {
    threadId: side2,
    parentId: lessonId,
    depth: 1,
    label: "reward",
    state: "open",
    noteStatus: null,
    section: null,
  },
];

describe("sideChatPath", () => {
  it("lists the lesson down to the thread", () => {
    expect(sideChatPath(rows, nested1).map((row) => row.threadId)).toEqual([
      lessonId,
      side1,
      nested1,
    ]);
    expect(sideChatPath(rows, lessonId).map((row) => row.threadId)).toEqual([lessonId]);
  });

  it("is empty for a thread that is not in the rows", () => {
    expect(sideChatPath(rows, "unknown")).toEqual([]);
  });

  it("stops at a parent that is not in the rows", () => {
    const orphaned: ReadonlyArray<SideChatTreeRow> = [
      {
        threadId: side1,
        parentId: lessonId,
        depth: 1,
        label: "a",
        state: "open",
        noteStatus: null,
        section: null,
      },
    ];
    expect(sideChatPath(orphaned, side1).map((row) => row.threadId)).toEqual([side1]);
  });

  it("terminates on rows whose parents form a cycle", () => {
    const cyclic: ReadonlyArray<SideChatTreeRow> = [
      {
        threadId: side1,
        parentId: nested1,
        depth: 1,
        label: "a",
        state: "open",
        noteStatus: null,
        section: null,
      },
      {
        threadId: nested1,
        parentId: side1,
        depth: 2,
        label: "b",
        state: "open",
        noteStatus: null,
        section: null,
      },
    ];
    expect(sideChatPath(cyclic, side1).map((row) => row.threadId)).toEqual([nested1, side1]);
  });
});

describe("sideChatSurfacePath and topSideChatId", () => {
  it("leaves the lesson out of the path", () => {
    expect(sideChatSurfacePath(rows, nested1)).toEqual(["side-1", "nested-1"]);
    expect(sideChatSurfacePath(rows, side2)).toEqual(["side-2"]);
    expect(sideChatSurfacePath(rows, lessonId)).toEqual([]);
    expect(sideChatSurfacePath(rows, "unknown")).toEqual([]);
  });

  it("names the top-level side chat of a nested one", () => {
    expect(topSideChatId(rows, nested1)).toBe("side-1");
    expect(topSideChatId(rows, side1)).toBe("side-1");
    expect(topSideChatId(rows, lessonId)).toBeNull();
    expect(topSideChatId(rows, "unknown")).toBeNull();
  });
});

describe("sideChatBreadcrumb", () => {
  it("runs from the lesson, called Lesson, down to the current side chat", () => {
    expect(sideChatBreadcrumb(rows, nested1, undefined)).toEqual([
      { threadId: "lesson-1", label: "Lesson", role: "lesson" },
      { threadId: "side-1", label: "observation space", role: "ancestor" },
      { threadId: "nested-1", label: "Box", role: "current" },
    ]);
  });

  it("adds the side chats the user walked back out of as forward crumbs", () => {
    const crumbs = sideChatBreadcrumb(rows, side1, ["side-1", "nested-1"]);
    expect(crumbs.map((crumb) => crumb.role)).toEqual(["lesson", "current", "forward"]);
    expect(crumbs.map((crumb) => crumb.label)).toEqual(["Lesson", "observation space", "Box"]);
  });

  it("has no forward crumbs at the end of the trail", () => {
    const crumbs = sideChatBreadcrumb(rows, nested1, ["side-1", "nested-1"]);
    expect(crumbs.map((crumb) => crumb.role)).toEqual(["lesson", "ancestor", "current"]);
  });

  it("ignores a trail that does not contain the current side chat", () => {
    const crumbs = sideChatBreadcrumb(rows, side2, ["side-1", "nested-1"]);
    expect(crumbs.map((crumb) => crumb.role)).toEqual(["lesson", "current"]);
  });

  it("skips forward crumbs whose side chat is gone", () => {
    const crumbs = sideChatBreadcrumb(rows, side1, ["side-1", "deleted-1", "nested-1"]);
    expect(crumbs.map((crumb) => crumb.threadId)).toEqual(["lesson-1", "side-1", "nested-1"]);
  });

  it("is empty for an unknown thread", () => {
    expect(sideChatBreadcrumb(rows, "unknown", undefined)).toEqual([]);
    expect(sideChatBreadcrumb(rows, "unknown", ["unknown"])).toEqual([]);
  });
});

describe("sideChatStatusLine", () => {
  const note = "They didn't know what an observation space is.";
  const toLesson = { label: null, delivered: true };

  it("says nothing while the side chat is open", () => {
    expect(sideChatStatusLine({ state: "open", noteStatus: null }, null, toLesson)).toBeNull();
  });

  it("says nothing without a side chat", () => {
    expect(sideChatStatusLine(undefined, null, toLesson)).toBeNull();
  });

  it.each([
    ["generating", "Writing note…"],
    ["none", "No note needed"],
    ["failed", "Couldn't write the note"],
  ] as const)("describes a done side chat whose note is %s", (noteStatus, line) => {
    expect(sideChatStatusLine({ state: "done", noteStatus }, null, toLesson)).toBe(line);
  });

  it.each([
    ["the lesson received", { label: null, delivered: true }, `Sent to lesson: ${note}`],
    [
      "the lesson has yet to receive",
      { label: null, delivered: false },
      `Goes with your next lesson message: ${note}`,
    ],
    [
      "a parent side chat received",
      { label: "observation space", delivered: true },
      `Sent to “observation space”: ${note}`,
    ],
    [
      "a parent side chat has yet to receive",
      { label: "observation space", delivered: false },
      `Goes with your next message in “observation space”: ${note}`,
    ],
  ] as const)("names where a ready note goes when %s it", (_case, parent, line) => {
    expect(sideChatStatusLine({ state: "done", noteStatus: "ready" }, note, parent)).toBe(line);
  });

  it("waits for the note text of a ready note instead of guessing", () => {
    expect(sideChatStatusLine({ state: "done", noteStatus: "ready" }, null, toLesson)).toBeNull();
  });

  it("waits to know whether the parent received a ready note instead of guessing", () => {
    expect(
      sideChatStatusLine({ state: "done", noteStatus: "ready" }, note, {
        label: null,
        delivered: null,
      }),
    ).toBeNull();
  });

  it("says nothing for a done side chat that never had a note started", () => {
    expect(sideChatStatusLine({ state: "done", noteStatus: null }, null, toLesson)).toBeNull();
  });
});

describe("sideChatComposerStatus", () => {
  it("says the side chat is starting until its shell exists", () => {
    expect(
      sideChatComposerStatus({
        shellExists: false,
        openingStatus: null,
        runActive: false,
        providerUnavailable: null,
      }),
    ).toBe("Starting side chat…");
  });

  it("says it is preparing context while the opening summary is written for a running side chat", () => {
    expect(
      sideChatComposerStatus({
        shellExists: true,
        openingStatus: "pending",
        runActive: true,
        providerUnavailable: null,
      }),
    ).toBe("Preparing context…");
  });

  it("says nothing when the summary is pending but no run waits for it", () => {
    expect(
      sideChatComposerStatus({
        shellExists: true,
        openingStatus: "pending",
        runActive: false,
        providerUnavailable: null,
      }),
    ).toBeNull();
  });

  it.each(["ready", "fallback", "failed", null] as const)(
    "says nothing once the opening is %s",
    (openingStatus) => {
      expect(
        sideChatComposerStatus({
          shellExists: true,
          openingStatus,
          runActive: true,
          providerUnavailable: null,
        }),
      ).toBeNull();
    },
  );

  it("says the side chat's provider is unavailable, since Send stays off until it is back", () => {
    expect(
      sideChatComposerStatus({
        shellExists: true,
        openingStatus: "ready",
        runActive: false,
        providerUnavailable: "unavailable",
      }),
    ).toBe("This side chat's provider is unavailable. Enable it in Settings → Providers.");
  });

  it("says the side chat's provider instance is gone rather than offering to enable it", () => {
    expect(
      sideChatComposerStatus({
        shellExists: true,
        openingStatus: "ready",
        runActive: false,
        providerUnavailable: "missing",
      }),
    ).toBe("This side chat's provider instance is no longer available on this device.");
  });
});

describe("sideChatAnchorCitation", () => {
  it("rebuilds the lesson citation the side chat was opened from", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const anchor = {
      threadId: lessonId,
      messageId: MessageId.make("assistant-1"),
      start: 3,
      end: 20,
      prefix: "An ",
      suffix: " is what",
    };
    expect(sideChatAnchorCitation(environmentId, anchor, "observation space")).toEqual({
      version: 1,
      environmentId,
      threadId: lessonId,
      messageId: "assistant-1",
      text: "observation space",
      start: 3,
      end: 20,
      prefix: "An ",
      suffix: " is what",
    });
  });

  it("drops the turn item id", () => {
    const citation = sideChatAnchorCitation(
      EnvironmentId.make("environment-1"),
      {
        threadId: lessonId,
        messageId: MessageId.make("assistant-1"),
        turnItemId: TurnItemId.make("item-1"),
        start: 0,
        end: 5,
        prefix: "",
        suffix: "",
      },
      "hello",
    );
    expect(Object.keys(citation).toSorted()).toEqual([
      "end",
      "environmentId",
      "messageId",
      "prefix",
      "start",
      "suffix",
      "text",
      "threadId",
      "version",
    ]);
  });
});

describe("sideChatAwaitingInput", () => {
  const shells = [
    makeThreadFixture({ id: lessonId, hasPendingApprovals: true }),
    makeSideChatThreadFixture({ id: side1, lessonId }),
    makeSideChatThreadFixture({ id: nested1, lessonId, parentId: side1 }),
  ];

  it("ignores a plain thread waiting for an answer", () => {
    expect(sideChatAwaitingInput(shells)).toBeNull();
  });

  it("finds the side chat waiting for an approval", () => {
    expect(
      sideChatAwaitingInput([...shells.slice(0, 2), { ...shells[2]!, hasPendingApprovals: true }]),
    ).toBe("nested-1");
  });

  it("finds the side chat waiting for an answer to a question", () => {
    expect(sideChatAwaitingInput([{ ...shells[1]!, hasPendingUserInput: true }, shells[2]!])).toBe(
      "side-1",
    );
  });

  it("is null when nothing waits", () => {
    expect(sideChatAwaitingInput([])).toBeNull();
  });
});

describe("appendComposerSnippet", () => {
  const snippet = "> observation space";

  it("uses the snippet alone for an empty draft", () => {
    expect(appendComposerSnippet("", snippet)).toBe(snippet);
  });

  it("separates the snippet from the text before it", () => {
    expect(appendComposerSnippet("Why", snippet)).toBe(`Why ${snippet}`);
  });

  it("does not double the space after text that already ends in one", () => {
    expect(appendComposerSnippet("Why ", snippet)).toBe(`Why ${snippet}`);
  });

  it("does not add a space after a line break", () => {
    expect(appendComposerSnippet("Why\n", snippet)).toBe(`Why\n${snippet}`);
  });
});

describe("shouldFinishSideChatOnClose", () => {
  const open = makeSideChatThreadFixture({ id: side1, lessonId });

  it("finishes a side chat nobody has written to", () => {
    expect(shouldFinishSideChatOnClose({ ...open, latestUserMessageAt: null })).toBe(true);
  });

  it("keeps a side chat that has a user message", () => {
    expect(
      shouldFinishSideChatOnClose({ ...open, latestUserMessageAt: "2026-01-01T00:00:00.000Z" }),
    ).toBe(false);
  });

  it("leaves a done side chat alone", () => {
    const done = makeSideChatThreadFixture({ id: side1, lessonId, state: "done" });
    expect(shouldFinishSideChatOnClose({ ...done, latestUserMessageAt: null })).toBe(false);
  });

  it("leaves ordinary threads and missing shells alone", () => {
    expect(shouldFinishSideChatOnClose(makeThreadFixture({ id: lessonId }))).toBe(false);
    expect(shouldFinishSideChatOnClose(null)).toBe(false);
  });
});

describe("lessonSideChatWaitLabel", () => {
  const writing = makeSideChatThreadFixture({
    id: side1,
    lessonId,
    state: "done",
    noteStatus: "generating",
  });

  it("says a note is being added while the lesson's run starts", () => {
    expect(
      lessonSideChatWaitLabel({
        lessonThreadId: lessonId,
        activityRunStatus: "starting",
        shells: [writing],
      }),
    ).toBe("Adding side-chat note…");
  });

  it("says nothing once the run is running", () => {
    expect(
      lessonSideChatWaitLabel({
        lessonThreadId: lessonId,
        activityRunStatus: "running",
        shells: [writing],
      }),
    ).toBeNull();
    expect(
      lessonSideChatWaitLabel({
        lessonThreadId: lessonId,
        activityRunStatus: null,
        shells: [writing],
      }),
    ).toBeNull();
  });

  it("says nothing when no note is being written", () => {
    const ready = makeSideChatThreadFixture({
      id: side1,
      lessonId,
      state: "done",
      noteStatus: "ready",
    });
    expect(
      lessonSideChatWaitLabel({
        lessonThreadId: lessonId,
        activityRunStatus: "starting",
        shells: [ready, makeThreadFixture({ id: lessonId })],
      }),
    ).toBeNull();
  });

  it("ignores notes written for another thread", () => {
    const nestedWriting = makeSideChatThreadFixture({
      id: nested1,
      lessonId,
      parentId: side1,
      state: "done",
      noteStatus: "generating",
    });
    expect(
      lessonSideChatWaitLabel({
        lessonThreadId: lessonId,
        activityRunStatus: "starting",
        shells: [nestedWriting],
      }),
    ).toBeNull();
  });
});
