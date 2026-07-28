import { describe, expect, it } from "vite-plus/test";
import { extractLeadingMessageReply } from "./messageReply";

describe("extractLeadingMessageReply", () => {
  it("separates a multiline Hermes reply envelope from the reply body", () => {
    expect(
      extractLeadingMessageReply(
        [
          '[Replying to: "~ [ ] Post the edited video',
          "",
          '[ ] Make an “evil CEO” edit"]',
          "i already said that the last item is done",
        ].join("\n"),
      ),
    ).toEqual({
      referencedText: "~ [ ] Post the edited video\n\n[ ] Make an “evil CEO” edit",
      messageText: "i already said that the last item is done",
    });
  });

  it("supports replies to Hermes's previous message", () => {
    expect(
      extractLeadingMessageReply(
        '[Replying to your previous message: "Use the direct train."]\n\nthis one',
      ),
    ).toEqual({
      referencedText: "Use the direct train.",
      messageText: "this one",
    });
  });

  it("supports CRLF-delimited imported replies", () => {
    expect(
      extractLeadingMessageReply('[Replying to: "Earlier message"]\r\nThis is my reply.'),
    ).toEqual({
      referencedText: "Earlier message",
      messageText: "This is my reply.",
    });
  });

  it("leaves ordinary and malformed messages alone", () => {
    expect(extractLeadingMessageReply("I am replying to the earlier message.")).toBeNull();
    expect(extractLeadingMessageReply('[Replying to: "Earlier message"]')).toBeNull();
    expect(extractLeadingMessageReply('[Replying to: ""]\nThis is my reply.')).toBeNull();
  });
});
