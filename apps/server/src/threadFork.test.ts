import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationThread } from "@t3tools/contracts";

import {
  makeThreadForkAttachment,
  makeThreadForkHandoffPrompt,
  makeThreadForkTranscript,
  threadForkMessageId,
  findThreadForkTranscriptAttachment,
} from "./threadFork.ts";

const source = {
  id: ThreadId.make("source-thread"),
  title: "Investigate the issue",
  messages: [
    {
      id: "m1",
      role: "user",
      text: "First question",
      attachments: [
        {
          type: "file",
          id: "source-file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
        },
      ],
    },
    { id: "m2", role: "system", text: "hidden runtime note" },
    { id: "m3", role: "assistant", text: "First answer" },
  ],
} as unknown as OrchestrationThread;

describe("thread fork handoff", () => {
  it("serializes persisted conversation text without copying provider internals", () => {
    const transcript = makeThreadForkTranscript(source);

    expect(transcript).toContain("Source thread: Investigate the issue");
    expect(transcript).toContain("## USER\n\nFirst question");
    expect(transcript).toContain("[Attachments referenced but not copied: notes.txt]");
    expect(transcript).toContain("## ASSISTANT\n\nFirst answer");
    expect(transcript).not.toContain("hidden runtime note");
    expect(transcript.indexOf("First question")).toBeLessThan(transcript.indexOf("First answer"));
  });

  it("derives stable operation, message, and child-owned attachment identities", () => {
    const threadId = ThreadId.make("new-thread");
    const transcript = makeThreadForkTranscript(source);
    const first = makeThreadForkAttachment({
      attachmentsDir: "/tmp/attachments",
      threadId,
      transcript,
    });
    const second = makeThreadForkAttachment({
      attachmentsDir: "/tmp/attachments",
      threadId,
      transcript,
    });

    expect(threadForkMessageId(threadId)).toBe("thread-fork:new-thread:handoff");
    expect(first).toEqual(second);
    expect(first?.attachment.id).toMatch(/^new-thread-[0-9a-f-]+-md$/);
    expect(first?.path).toBe(`/tmp/attachments/${first?.attachment.id}.md`);
  });

  it("makes the first turn a context handoff that waits for the user", () => {
    expect(makeThreadForkHandoffPrompt(source)).toContain("source-thread");
    expect(makeThreadForkHandoffPrompt(source)).toContain("Wait for the user's next request");
  });

  it("flattens the recognized transcript when forking an existing fork", () => {
    const forkId = ThreadId.make("first-fork");
    const inherited = makeThreadForkTranscript(source);
    const stored = makeThreadForkAttachment({
      attachmentsDir: "/tmp/attachments",
      threadId: forkId,
      transcript: inherited,
    });
    expect(stored).not.toBeNull();
    const fork = {
      ...source,
      id: forkId,
      title: "Investigate the issue (fork)",
      messages: [
        {
          id: threadForkMessageId(forkId),
          role: "user",
          text: makeThreadForkHandoffPrompt(source),
          attachments: [stored!.attachment],
        },
        { id: "fork-answer", role: "assistant", text: "Ready for the next request" },
        { id: "fork-user", role: "user", text: "Continue with this constraint" },
      ],
    } as unknown as OrchestrationThread;

    expect(findThreadForkTranscriptAttachment(fork)).toEqual(stored!.attachment);
    const nextTranscript = makeThreadForkTranscript(fork, inherited);
    expect(nextTranscript).toContain("First question");
    expect(nextTranscript).toContain("First answer");
    expect(nextTranscript).toContain("Continue with this constraint");
    expect(nextTranscript).not.toContain(makeThreadForkHandoffPrompt(source));
  });

  it("rejects transcripts larger than the provider file limit instead of truncating them", () => {
    const tooLarge = "x".repeat(50 * 1024 * 1024 + 1);
    expect(
      makeThreadForkAttachment({
        attachmentsDir: "/tmp/attachments",
        threadId: ThreadId.make("new-thread"),
        transcript: tooLarge,
      }),
    ).toBeNull();
  });
});
