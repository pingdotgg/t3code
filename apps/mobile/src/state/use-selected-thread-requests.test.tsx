import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  uploads: {} as Record<string, unknown>,
  preparations: {} as Record<string, number>,
  preparationAtom: Symbol("preparation"),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "drafts"
      ? fixture.drafts
      : atom === "uploads"
        ? fixture.uploads
        : atom === fixture.preparationAtom
          ? fixture.preparations
          : {},
}));
vi.mock("./use-composer-drafts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-composer-drafts")>()),
  // The render path reads drafts through the mocked useAtomValue below.
  composerDraftsAtom: "drafts",
}));
vi.mock("expo-file-system", () => {
  class StubEntry {
    parentDirectory: unknown = null;
    name = "";
    exists = false;
    constructor(parent: unknown, name?: string) {
      this.parentDirectory = parent;
      if (name) this.name = name;
    }
    create() {}
    write() {}
    moveSync() {}
    async text() {
      return "";
    }
  }
  return {
    Directory: StubEntry,
    File: StubEntry,
    Paths: { document: { uri: "file:///documents" } },
  };
});
vi.mock("./composer-attachment-uploads", async () => ({
  ...(await import("../lib/composerAttachmentUploadQueue")),
  composerAttachmentUploadsAtom: "uploads",
}));
vi.mock("./question-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./question-attachments")>()),
  questionAttachmentPreparationAtom: fixture.preparationAtom,
}));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 20_000_000 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", () => ({
  useSelectedThreadDetail: () => ({
    activities: [
      {
        id: "request-activity",
        kind: "user-input.requested",
        createdAt: "2026-09-08T00:00:00Z",
        payload: {
          requestId: "request-1",
          questions: ["first", "second"].map((id) => ({
            id,
            header: id,
            question: `Attach ${id} file`,
            options: [],
            allowCustomAnswer: true,
          })),
        },
      },
    ],
  }),
}));

import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { questionAttachmentDraftKey } from "./question-attachments";
import { getComposerDraftSnapshot, setComposerDraftText } from "./use-composer-drafts";
import { scopedThreadKey } from "../lib/scopedEntities";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

const environmentId = EnvironmentId.make("environment-1");
const key = (question: string) =>
  questionAttachmentDraftKey(
    environmentId,
    ThreadId.make("thread-1"),
    ApprovalRequestId.make("request-1"),
    question,
  );
function submitButtonMarkup() {
  function Probe() {
    const { activePendingUserInputAnswers } = useSelectedThreadRequests();
    return <button disabled={activePendingUserInputAnswers === null}>Submit answers</button>;
  }
  return renderToStaticMarkup(<Probe />);
}
beforeEach(() => {
  fixture.preparations = {};
  fixture.drafts = Object.fromEntries(
    ["first", "second"].map((id) => [
      key(id),
      {
        attachments: [
          {
            id,
            type: "file",
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: `file:///${id}.txt`,
          },
        ],
      },
    ]),
  );
  fixture.uploads = { "environment-1:first": { status: "ready" } };
});
describe("question attachment submission readiness", () => {
  it.each([
    undefined,
    { status: "uploading", progress: 0.5 },
    { status: "failed", reason: "Offline" },
  ])("keeps Submit disabled until all question uploads finish: %j", (state) => {
    if (state) fixture.uploads["environment-1:second"] = state;
    expect(submitButtonMarkup()).toContain("disabled");
    fixture.uploads["environment-1:second"] = { status: "ready" };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("ignores an upload in another environment", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.uploads["environment-2:second"] = { status: "uploading", progress: 0.5 };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("waits for attachment preparation even when uploads are ready", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.preparations[key("first")] = 1;
    expect(submitButtonMarkup()).toContain("disabled");
  });
});

describe("user input answer drafting", () => {
  it("moves a typed custom answer into the thread draft when an option replaces it", () => {
    const threadDraftKey = scopedThreadKey(environmentId, ThreadId.make("thread-1"));
    setComposerDraftText(threadDraftKey, "Existing draft");

    const captured: { current: ReturnType<typeof useSelectedThreadRequests> | null } = {
      current: null,
    };
    function Probe() {
      captured.current = useSelectedThreadRequests();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    const hook = captured.current!;
    const request = hook.activePendingUserInput!;
    expect(request.requestId).toBe("request-1");

    hook.onChangeUserInputCustomAnswer(request.requestId, "first", "  also rename the flag  ");
    hook.onSelectUserInputOption(request.requestId, request.questions[0]!, "keep");

    expect(getComposerDraftSnapshot(threadDraftKey).text).toBe(
      "Existing draft\n\nalso rename the flag",
    );
  });
});
