import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { TextInputDialogRequest } from "../../components/ui/Dialog";
import { appAtomRegistry } from "../../state/atom-registry";
import { beginQueuedRunEdit, queuedEditDraftKey } from "../../state/queued-run-edit";
import { getComposerDraftSnapshot } from "../../state/use-composer-drafts";
import { citeAssistantText } from "./citeAssistantText";

const prompts: TextInputDialogRequest[] = [];
vi.mock("../../components/ui/Dialog", () => ({
  alert: vi.fn(),
  prompt: (request: TextInputDialogRequest) => prompts.push(request),
}));

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    moveSync() {}
  },
  Paths: { document: { uri: "file:///documents" } },
}));

describe("citeAssistantText", () => {
  it("cites into the thread draft when the queued edit ends while the prompt is open", () => {
    prompts.length = 0;
    const environmentId = EnvironmentId.make("env-cite");
    const threadId = ThreadId.make("thread-cite");
    const threadKey = `${environmentId}:${threadId}`;
    const runId = RunId.make("run-cite");
    const runs = Atom.make<ReadonlyArray<{ readonly id: RunId; readonly status: string }> | null>([
      { id: runId, status: "queued" },
    ]);
    beginQueuedRunEdit(
      threadKey,
      { runId, messageId: MessageId.make("queued"), originalText: "", existingAttachments: [] },
      runs,
    );

    citeAssistantText(
      { environmentId, threadId, messageId: MessageId.make("reply") },
      { text: "complete", start: 0 },
    );
    appAtomRegistry.set(runs, [{ id: runId, status: "running" }]);
    prompts[0]!.onConfirm("Why?");

    expect(getComposerDraftSnapshot(queuedEditDraftKey(threadKey, runId)).text).toBe("");
    expect(
      collectAssistantCitations(getComposerDraftSnapshot(threadKey).text).map(({ citation }) => [
        citation.text,
        citation.comment,
      ]),
    ).toEqual([["complete", "Why?"]]);
  });
});
