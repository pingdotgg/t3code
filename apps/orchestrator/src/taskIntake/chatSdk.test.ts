import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";

import { slackChatMessageToTaskIntakeMessage } from "./chatSdk.ts";

function slackMessage(overrides?: Record<string, unknown>) {
  return {
    id: "1712345678.000200",
    threadId: "slack:T123:C123:1712345678.000100",
    text: "Please inspect this",
    raw: {
      team: "T123",
      channel: "C123",
      thread_ts: "1712345678.000100",
      ts: "1712345678.000200",
    },
    metadata: {
      dateSent: new Date("2026-05-14T10:00:00.000Z"),
    },
    author: {
      userId: "U123",
      userName: "Vivek",
      fullName: "Vivek",
    },
    attachments: [],
    ...overrides,
  };
}

const slackThread = {
  id: "slack:T123:C123:1712345678.000100",
  channelId: "C123",
};

describe("Slack Chat SDK intake attachments", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("converts image attachments to native upload payloads", async () => {
    const message = await slackChatMessageToTaskIntakeMessage({
      thread: slackThread as never,
      message: slackMessage({
        attachments: [
          {
            type: "image",
            name: "screenshot.png",
            mimeType: "image/png",
            size: 4,
            url: "https://files.slack.com/files-pri/T123-F123/screenshot.png",
            fetchData: async () => Buffer.from("test"),
          },
        ],
      }) as never,
    });

    expect(message.attachments).toHaveLength(1);
    expect(message.attachments?.[0]).toMatchObject({
      type: "image",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    });
    expect(message.attachments?.[0]).toHaveProperty("dataUrl", "data:image/png;base64,dGVzdA==");
  });

  it("falls back to the Slack bot token when rehydrated attachments cannot fetch themselves", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    const fetchMock = vi.fn(async (url: string) => {
      if (url.startsWith("https://slack.com/api/files.info")) {
        return Response.json({
          ok: true,
          file: {
            url_private_download:
              "https://files.slack.com/files-pri/T123-F12345678/download/rehydrated.png",
          },
        });
      }
      return new Response(Buffer.from("image-bytes"), {
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const message = await slackChatMessageToTaskIntakeMessage({
      thread: slackThread as never,
      message: slackMessage({
        attachments: [
          {
            type: "image",
            name: "rehydrated.png",
            mimeType: "image/png",
            size: 11,
            url: "https://files.slack.com/files-pri/T123-F12345678/rehydrated.png",
            fetchData: async () => {
              throw new Error("Installation not found for team T123");
            },
          },
        ],
      }) as never,
    });

    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/files.info?file=F12345678", {
      headers: { Authorization: "Bearer xoxb-test" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://files.slack.com/files-pri/T123-F12345678/download/rehydrated.png",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer xoxb-test",
        }),
      }),
    );
    expect(message.attachments?.[0]).toMatchObject({
      type: "image",
      name: "rehydrated.png",
      mimeType: "image/png",
      sizeBytes: 11,
    });
    expect(message.attachments?.[0]).toHaveProperty(
      "dataUrl",
      "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    );
  });

  it("treats generic Slack files with image names as native images", async () => {
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(Buffer.from("png-by-name"), {
          headers: { "content-type": "image/png" },
        });
      }),
    );

    const message = await slackChatMessageToTaskIntakeMessage({
      thread: slackThread as never,
      message: slackMessage({
        attachments: [
          {
            type: "file",
            name: "image.png",
            size: 11,
            url: "https://files.slack.com/files-pri/T123-F126/image.png",
          },
        ],
      }) as never,
    });

    expect(message.attachments?.[0]).toMatchObject({
      type: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 11,
    });
    expect(message.attachments?.[0]).toHaveProperty(
      "dataUrl",
      "data:image/png;base64,cG5nLWJ5LW5hbWU=",
    );
  });

  it("keeps non-image attachments as links", async () => {
    const message = await slackChatMessageToTaskIntakeMessage({
      thread: slackThread as never,
      message: slackMessage({
        attachments: [
          {
            type: "file",
            name: "notes.pdf",
            mimeType: "application/pdf",
            size: 12,
            url: "https://files.slack.com/files-pri/T123-F124/notes.pdf",
          },
        ],
      }) as never,
    });

    expect(message.attachments).toEqual([
      {
        type: "file",
        name: "notes.pdf",
        mimeType: "application/pdf",
        sizeBytes: 12,
        url: "https://files.slack.com/files-pri/T123-F124/notes.pdf",
      },
    ]);
  });
});
