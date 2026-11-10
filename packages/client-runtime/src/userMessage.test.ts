import { describe, expect, it } from "vite-plus/test";

import { ComposerContextId, GuestMessageId, ScheduledTaskId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import {
  resolveUserMessageFileCards,
  resolveUserMessageGrouping,
  resolveUserMessagePresentation,
} from "./userMessage.ts";

describe("resolveUserMessageGrouping", () => {
  const own = { role: "user", text: "hello" };

  it("groups only adjacent own messages", () => {
    expect(resolveUserMessageGrouping(own, own, own)).toEqual({
      groupedWithPrevious: true,
      groupedWithNext: true,
      continuesSteer: false,
    });
    expect(resolveUserMessageGrouping(own, undefined, own)).toMatchObject({
      groupedWithPrevious: false,
      groupedWithNext: true,
    });
    for (const boundary of [
      undefined,
      { ...own, role: "assistant" },
      { ...own, createdBy: "agent" as const },
      { ...own, createdBy: "agent" as const, creationSource: "server" as const },
      { ...own, scheduledTaskId: ScheduledTaskId.make("task") },
      {
        ...own,
        context: {
          guest: { guestMessageId: GuestMessageId.make("guest"), name: "Sam", text: "hi" },
        },
      },
    ]) {
      expect(resolveUserMessageGrouping(own, boundary, boundary)).toEqual({
        groupedWithPrevious: false,
        groupedWithNext: false,
        continuesSteer: false,
      });
      expect(resolveUserMessageGrouping(boundary, own, own)).toEqual({
        groupedWithPrevious: false,
        groupedWithNext: false,
        continuesSteer: false,
      });
    }
  });

  it("shows one label for consecutive steers, including promoted queued messages", () => {
    for (const inputIntent of ["steer", "promoted_queued_to_steer"] as const) {
      const steer = { ...own, inputIntent };
      expect(
        resolveUserMessageGrouping(steer, { ...own, inputIntent: "steer" }, undefined)
          .continuesSteer,
      ).toBe(true);
      expect(
        resolveUserMessageGrouping(
          steer,
          { ...own, inputIntent: "promoted_queued_to_steer" },
          undefined,
        ).continuesSteer,
      ).toBe(true);
      expect(resolveUserMessageGrouping(steer, own, undefined).continuesSteer).toBe(false);
      expect(resolveUserMessageGrouping(own, steer, undefined).continuesSteer).toBe(false);
    }
  });
});

describe("resolveUserMessageFileCards", () => {
  const file = {
    type: "file" as const,
    id: "report",
    name: "report.pdf",
    mimeType: "application/pdf",
    sizeBytes: 1024,
  };
  const record = {
    ...file,
    version: 1 as const,
    kind: "file" as const,
    contextId: ComposerContextId.make("report"),
    label: file.name,
    attachmentId: file.id,
  };
  const context = { version: 1 as const, records: [record] };
  const reference = "[report.pdf](t3-context://v1/file/report)";

  it("shows file cards for bare attachments and bound file references", () => {
    for (const text of ["", " \n", reference]) {
      expect(resolveUserMessageFileCards({ text, attachments: [file], context })).toEqual([file]);
    }
    expect(
      resolveUserMessageFileCards({
        text: `${reference}\n${reference}`,
        attachments: [file],
        context,
      }),
    ).toEqual([file]);
  });

  it("keeps words and unavailable or non-file references in the bubble", () => {
    for (const text of [
      `read ${reference}`,
      "[missing.pdf](t3-context://v1/file/missing)",
      "[report.pdf](t3-context://v1/mention/report)",
    ]) {
      expect(resolveUserMessageFileCards({ text, attachments: [file], context })).toBeNull();
    }
    expect(resolveUserMessageFileCards({ text: reference, attachments: [file] })).toBeNull();
    expect(
      resolveUserMessageFileCards({
        text: reference,
        attachments: [file],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              kind: "file",
              contextId: record.contextId,
              label: file.name,
              payload: {},
            },
          ],
        },
      }),
    ).toBeNull();
    expect(
      resolveUserMessageFileCards({
        text: reference,
        attachments: [{ ...file, id: "other" }],
        context,
      }),
    ).toBeNull();
  });

  it("keeps media, unknown attachments, and empty messages out of the file cards", () => {
    const media = [
      { ...file, type: "image" as const, name: "photo.png", mimeType: "image/png" },
      { ...file, name: "photo.png", mimeType: "application/octet-stream" },
      { ...file, name: "clip.mp4", mimeType: "video/mp4" },
      { ...file, name: "clip.mov", mimeType: "application/octet-stream" },
      { ...file, name: "voice.mp3", mimeType: "audio/mpeg" },
      { ...file, type: "future" },
    ];
    expect(resolveUserMessageFileCards({ text: "", attachments: [] })).toBeNull();
    for (const attachment of media) {
      expect(resolveUserMessageFileCards({ text: "", attachments: [attachment] })).toBeNull();
      expect(resolveUserMessageFileCards({ text: "", attachments: [file, attachment] })).toBeNull();
    }
  });
});

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("hides the prompt that stands in for an attachment-only message", () => {
    for (const text of [
      ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
      `Ultrathink:\n${ATTACHMENT_ONLY_BOOTSTRAP_PROMPT}`,
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", text })).toEqual({
        text: "",
        attribution: null,
        scheduledTaskId: undefined,
      });
    }
  });

  it("shows a guest's own words and name, not the attributed text the agent reads", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "user",
        text: "Message from guest Sam, sent by the owner:\n\nWhy?",
        context: {
          guest: {
            guestMessageId: GuestMessageId.make("guest-message:one"),
            name: "Sam",
            text: "Why?",
          },
        },
      }),
    ).toEqual({ text: "Why?", attribution: "guest", scheduledTaskId: undefined, guestName: "Sam" });
  });

  it("attributes older server-sent restart continuations to T3 Code, not another agent", () => {
    const text = "Note: the T3 server restarted.";
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        creationSource: "server",
        text,
      }),
    ).toMatchObject({ attribution: "t3code" });
    for (const creationSource of ["mcp", "provider"] as const) {
      expect(
        resolveUserMessagePresentation({ role: "user", createdBy: "agent", creationSource, text }),
      ).toMatchObject({ attribution: "agent" });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        attribution: "automation",
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});
