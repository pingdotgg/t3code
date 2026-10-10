import {
  ASSISTANT_CITATION_MAX_COMMENT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
} from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";
import { describe, expect, it } from "vite-plus/test";

import {
  assistantCitationDraftKey,
  commitAssistantCitationCommentDrafts,
  readAssistantCitationCommentDraft,
  restoreAssistantCitationCommentDrafts,
  takeAssistantCitationCommentDraftsForComposer,
  writeAssistantCitationCommentDraft,
} from "./assistantCitationCommentDrafts";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make("source"),
  text: "hello",
  start: 0,
  end: 5,
  prefix: "",
  suffix: "",
};
const other: AssistantCitation = { ...citation, text: "world", start: 6, end: 11 };

describe("assistantCitationDraftKey", () => {
  it("is the same for the same citation whatever nodes come before it", () => {
    expect(assistantCitationDraftKey(citation, [])).toBe(
      assistantCitationDraftKey(citation, [other]),
    );
  });

  it("tells identical citations apart by their order in the document", () => {
    const first = assistantCitationDraftKey(citation, []);
    const second = assistantCitationDraftKey(citation, [citation]);
    const third = assistantCitationDraftKey(citation, [other, citation, citation]);
    expect(new Set([first, second, third]).size).toBe(3);
    // The same prompt rebuilt in the same order yields the same keys again.
    expect(assistantCitationDraftKey(citation, [citation])).toBe(second);
  });

  it("keeps the same citation apart across composers", () => {
    expect(assistantCitationDraftKey(citation, [], "thread-a")).not.toBe(
      assistantCitationDraftKey(citation, [], "thread-b"),
    );
  });
});

describe("commitAssistantCitationCommentDrafts", () => {
  it("writes a trimmed draft onto its citation, preserves surrounding text, and removes the draft", () => {
    const scope = "commit-new-comment";
    const key = assistantCitationDraftKey(citation, [], scope);
    const before = "Before the quote.\n\n";
    const after = "\nAfter the quote.  ";
    const prompt = `${before}${serializeAssistantCitation(citation)}${after}`;
    writeAssistantCitationCommentDraft(key, " \n Please explain this. \t ");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    const expected = { ...citation, comment: "Please explain this." };
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([expected]);
    expect(committed).toBe(`${before}${serializeAssistantCitation(expected)}${after}`);
    expect(readAssistantCitationCommentDraft(key)).toBeNull();
  });

  it("replaces a saved comment with a different draft and removes the draft", () => {
    const scope = "commit-replacement-comment";
    const saved = { ...citation, comment: "Old comment" };
    const key = assistantCitationDraftKey(saved, [], scope);
    const prompt = serializeAssistantCitation(saved);
    writeAssistantCitationCommentDraft(key, "New comment");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([
      { ...citation, comment: "New comment" },
    ]);
    expect(readAssistantCitationCommentDraft(key)).toBeNull();
  });

  it("leaves the prompt unchanged and removes a draft equal to the saved comment after trimming", () => {
    const scope = "commit-unchanged-comment";
    const saved = { ...citation, comment: "Saved comment" };
    const key = assistantCitationDraftKey(saved, [], scope);
    const prompt = serializeAssistantCitation(saved);
    writeAssistantCitationCommentDraft(key, " \n Saved comment \t ");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(committed).toBe(prompt);
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([saved]);
    expect(readAssistantCitationCommentDraft(key)).toBeNull();
  });

  it("leaves the prompt unchanged and retains a draft over the comment length limit", () => {
    const scope = "commit-over-limit-comment";
    const key = assistantCitationDraftKey(citation, [], scope);
    const prompt = serializeAssistantCitation(citation);
    const draft = "x".repeat(ASSISTANT_CITATION_MAX_COMMENT_LENGTH + 1);
    writeAssistantCitationCommentDraft(key, draft);

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(committed).toBe(prompt);
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([citation]);
    expect(readAssistantCitationCommentDraft(key)).toBe(draft);
  });

  it("commits different drafts for identical citations using their original ordinals", () => {
    const scope = "commit-duplicate-citations";
    const first = assistantCitationDraftKey(citation, [], scope);
    const second = assistantCitationDraftKey(citation, [citation], scope);
    const link = serializeAssistantCitation(citation);
    const prompt = `Before ${link}\nBetween ${link}\nAfter`;
    writeAssistantCitationCommentDraft(first, "First comment");
    writeAssistantCitationCommentDraft(second, "Second comment");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    const expectedFirst = { ...citation, comment: "First comment" };
    const expectedSecond = { ...citation, comment: "Second comment" };
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([
      expectedFirst,
      expectedSecond,
    ]);
    expect(committed).toBe(
      `Before ${serializeAssistantCitation(expectedFirst)}\nBetween ${serializeAssistantCitation(expectedSecond)}\nAfter`,
    );
    expect(readAssistantCitationCommentDraft(first)).toBeNull();
    expect(readAssistantCitationCommentDraft(second)).toBeNull();
  });

  it("changes only the second of two different citations when only it has a draft", () => {
    const scope = "commit-second-citation";
    const first = assistantCitationDraftKey(citation, [], scope);
    const second = assistantCitationDraftKey(other, [citation], scope);
    const firstLink = serializeAssistantCitation(citation);
    const prompt = `${firstLink}\nBetween\n${serializeAssistantCitation(other)}`;
    writeAssistantCitationCommentDraft(second, "Comment on world");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    const expectedSecond = { ...other, comment: "Comment on world" };
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([
      citation,
      expectedSecond,
    ]);
    expect(committed).toBe(`${firstLink}\nBetween\n${serializeAssistantCitation(expectedSecond)}`);
    expect(readAssistantCitationCommentDraft(first)).toBeNull();
    expect(readAssistantCitationCommentDraft(second)).toBeNull();
  });

  it("neither applies nor removes drafts belonging to another scope", () => {
    const scope = "commit-scope-isolation";
    const elsewhere = assistantCitationDraftKey(citation, [], "commit-scope-isolation-other");
    const prompt = serializeAssistantCitation(citation);
    writeAssistantCitationCommentDraft(elsewhere, "Another composer's comment");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(committed).toBe(prompt);
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([citation]);
    expect(readAssistantCitationCommentDraft(elsewhere)).toBe("Another composer's comment");
  });

  it("returns the same prompt when its citations have no drafts", () => {
    const scope = "commit-no-drafts";
    const first = assistantCitationDraftKey(citation, [], scope);
    const second = assistantCitationDraftKey(other, [citation], scope);
    const prompt = `Before ${serializeAssistantCitation(citation)}\n${serializeAssistantCitation(other)} After`;

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(committed).toBe(prompt);
    expect(collectAssistantCitations(committed).map((entry) => entry.citation)).toEqual([
      citation,
      other,
    ]);
    expect(readAssistantCitationCommentDraft(first)).toBeNull();
    expect(readAssistantCitationCommentDraft(second)).toBeNull();
  });

  it("returns the same prompt without citations and retains its scope's unrelated draft", () => {
    const scope = "commit-no-citations";
    const key = assistantCitationDraftKey(citation, [], scope);
    const prompt = "Plain prompt\n[ordinary link](https://example.com)  ";
    writeAssistantCitationCommentDraft(key, "Keep this draft");

    const committed = commitAssistantCitationCommentDrafts(prompt, scope);

    expect(committed).toBe(prompt);
    expect(collectAssistantCitations(committed)).toEqual([]);
    expect(readAssistantCitationCommentDraft(key)).toBe("Keep this draft");
  });
});

describe("takeAssistantCitationCommentDraftsForComposer", () => {
  it("takes the sent composer's drafts, keeps every other composer's, and restores what it took", () => {
    const sent = assistantCitationDraftKey(citation, [], "thread-a");
    const sentDuplicate = assistantCitationDraftKey(citation, [citation], "thread-a");
    const elsewhere = assistantCitationDraftKey(citation, [], "thread-b");
    writeAssistantCitationCommentDraft(sent, "first");
    writeAssistantCitationCommentDraft(sentDuplicate, "second");
    writeAssistantCitationCommentDraft(elsewhere, "other");

    const taken = takeAssistantCitationCommentDraftsForComposer("thread-a");

    expect(readAssistantCitationCommentDraft(sent)).toBeNull();
    expect(readAssistantCitationCommentDraft(sentDuplicate)).toBeNull();
    expect(readAssistantCitationCommentDraft(elsewhere)).toBe("other");

    // A failed send gives the prompt back, and its drafts with it.
    restoreAssistantCitationCommentDrafts(taken);

    expect(readAssistantCitationCommentDraft(sent)).toBe("first");
    expect(readAssistantCitationCommentDraft(sentDuplicate)).toBe("second");
  });
});
