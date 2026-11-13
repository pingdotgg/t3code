import {
  EnvironmentId,
  MessageId,
  ThreadId,
  describe,
  expect,
  it,
  resolveAssistantMessageCopyState,
  serializeAssistantCitation,
  shouldCollapseUserMessage,
} from "./MessagesTimeline.logic-fixtures.ts";

describe("resolveAssistantMessageCopyState", () => {
  it("copies the rendered representation of Codex directives", () => {
    expect(
      resolveAssistantMessageCopyState({
        showCopyButton: true,
        text: [
          'Created :codex-file-citation{path="outputs/report.xlsx" purpose="output"}.',
          "",
          '::artifact-template{skill_name="artifact-template-hello-world" skill_directory="/Users/test/.codex/skills/artifact-template-hello-world" display_name="Hello World" artifact_kind="document"}',
        ].join("\n"),
        streaming: false,
      }),
    ).toEqual({
      text: "Created [report.xlsx](<outputs/report.xlsx>).\n\nHello World (Document template)",
      visible: true,
    });
  });
});

describe("shouldCollapseUserMessage", () => {
  it("measures a quote chip by its label, not its encoded link", () => {
    const quote = "A long assistant paragraph that the user quoted. ".repeat(40);
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("source"),
      text: quote,
      comment: "Why does this matter?",
      start: 0,
      end: quote.length,
      prefix: "",
      suffix: "",
    });

    expect(shouldCollapseUserMessage(`${citation} Can you expand on this?`)).toBe(false);
    expect(shouldCollapseUserMessage(`${citation} ${"More text. ".repeat(60)}`)).toBe(true);
  });
});
