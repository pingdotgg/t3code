import { describe, expect, it } from "vite-plus/test";

import {
  formatSupportEmailForAgent,
  supportEmailLookupExternalIds,
  supportEmailSlackPreview,
  supportEmailStoredExternalIds,
  supportEmailUploadAttachments,
  type ProcessedSupportEmailAttachment,
  type ResendReceivedEmail,
  type SupportEmailContext,
} from "./supportEmail.ts";

const context = {
  groupAddress: "support@nextcard.com",
  internalDomains: ["affil.ai"],
  productName: "Nextcard",
  repoName: "nextcard",
} satisfies SupportEmailContext;

describe("support email external ids", () => {
  it("matches referenced messages and stores normalized conversation ids", () => {
    const email = {
      id: "email-1",
      from: "User <user@example.com>",
      to: ["support@nextcard.com"],
      subject: "Re: Login fails",
      message_id: "<msg-2@mail.example>",
      headers: {
        "In-Reply-To": "<msg-1@mail.example>",
        References: "<root@mail.example> <msg-1@mail.example>",
      },
      text: "I still cannot log in.",
    } satisfies ResendReceivedEmail;

    expect(supportEmailLookupExternalIds(email, context)).toEqual(
      expect.arrayContaining([
        "message:root@mail.example",
        "message:msg-1@mail.example",
        "message:msg-2@mail.example",
        "<msg-2@mail.example>",
        "message-id:<msg-2@mail.example>",
        "resend:email-1",
      ]),
    );
    expect(supportEmailStoredExternalIds(email, context)).toContain(
      "conversation:user@example.com:login fails",
    );
  });

  it("uses conversation fallback for staff forwards", () => {
    const email = {
      id: "email-2",
      from: "Staff <triage@affil.ai>",
      to: ["support@nextcard.com"],
      subject: "Fwd: Checkout broken",
      text: "Can you look?\n\nBegin forwarded message:\nFrom: User <user@example.com>",
    } satisfies ResendReceivedEmail;

    expect(supportEmailLookupExternalIds(email, context)).toContain(
      "conversation:user@example.com:checkout broken",
    );
  });
});

describe("support email formatting", () => {
  const attachments = [
    {
      kind: "stored",
      id: "att-1",
      name: "screenshot.png",
      mimeType: "image/png",
      sizeBytes: 12,
      localPath: "/tmp/t3/support-email-attachments/email-1/screenshot.png",
      nativeImageDataUrl: "data:image/png;base64,ZmFrZQ==",
    },
  ] satisfies readonly ProcessedSupportEmailAttachment[];

  it("keeps local attachment paths in the agent prompt but not the Slack preview", () => {
    const email = {
      id: "email-1",
      from: "user@example.com",
      to: ["support@nextcard.com"],
      subject: "Screenshot",
      text: "This is broken.",
    } satisfies ResendReceivedEmail;

    expect(formatSupportEmailForAgent(email, attachments, context)).toContain(
      "/tmp/t3/support-email-attachments/email-1/screenshot.png",
    );
    expect(supportEmailSlackPreview({ email, attachments, context })).not.toContain(
      "/tmp/t3/support-email-attachments/email-1/screenshot.png",
    );
  });

  it("includes parsed reply-to and raw sender headers in the agent prompt", () => {
    const email = {
      id: "email-2",
      from: "help@nextcard.com",
      reply_to: ["supastars3@aol.com"],
      to: ["nextcard-help@example.resend.app"],
      subject: "Support Request",
      text: "My credits are missing.",
      headers: {
        from: '"Doreen Sargente via Support/Help" <help@nextcard.com>',
        "reply-to": '"Doreen Sargente" <supastars3@aol.com>',
        "x-original-from": "Doreen Sargente <supastars3@aol.com>",
        "x-original-sender": "supastars3@aol.com",
      },
    } satisfies ResendReceivedEmail;

    const prompt = formatSupportEmailForAgent(email, [], context);
    expect(prompt).toContain("From: help@nextcard.com");
    expect(prompt).toContain("Reply-To: supastars3@aol.com");
    expect(prompt).toContain("Email identity headers:");
    expect(prompt).toContain('Header-From: "Doreen Sargente via Support/Help" <help@nextcard.com>');
    expect(prompt).toContain('Header-Reply-To: "Doreen Sargente" <supastars3@aol.com>');
    expect(prompt).toContain("Header-X-Original-From: Doreen Sargente <supastars3@aol.com>");
    expect(prompt).toContain("Header-X-Original-Sender: supastars3@aol.com");
  });

  it("truncates quoted chains from Slack previews", () => {
    const email = {
      id: "email-3",
      from: "user@example.com",
      to: ["support@nextcard.com"],
      subject: "Retry failed",
      text: "The retry button still fails.\n\nOn May 28, Support wrote:\nold thread body",
    } satisfies ResendReceivedEmail;

    const preview = supportEmailSlackPreview({ email, context });
    expect(preview).toContain("The retry button still fails.");
    expect(preview).not.toContain("old thread body");
  });

  it("forwards small downloaded images as native provider attachments", () => {
    expect(supportEmailUploadAttachments(attachments)).toEqual([
      {
        type: "image",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 12,
        dataUrl: "data:image/png;base64,ZmFrZQ==",
      },
    ]);
  });
});
