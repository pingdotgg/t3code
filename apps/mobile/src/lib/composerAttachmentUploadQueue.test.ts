import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  questionAttachmentDraftKey,
  questionAttachmentDraftPrefix,
} from "../state/question-attachments";
vi.mock("../state/atom-registry", () => ({ appAtomRegistry: {} }));

import {
  composerAttachmentUploadBlockReason,
  composerAttachmentsStillUploading,
  composerAttachmentUploadKey,
  composerDraftEnvironmentId,
  type ComposerAttachmentUploadRequest,
} from "./composerAttachmentUploadQueue";

const environmentId = EnvironmentId.make("environment-1");
function request(id: string, environment = environmentId): ComposerAttachmentUploadRequest {
  return {
    environmentId: environment,
    attachment: {
      id,
      type: "file",
      name: `${id}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: 42,
      fileUri: `file:///documents/${id}.pdf`,
    },
  };
}

describe("draft upload scope and offline submission", () => {
  it("uploads question drafts in their environment without matching other thread prefixes", () => {
    const requestId = ApprovalRequestId.make("request:1");
    for (const environment of [environmentId, EnvironmentId.make("remote:server")]) {
      const threadId = ThreadId.make("thread:1");
      const prefix = questionAttachmentDraftPrefix(environment, threadId);
      const key = questionAttachmentDraftKey(environment, threadId, requestId, "question:1");
      expect(composerDraftEnvironmentId(key, [environment], [])).toBe(environment);
      expect(key.startsWith(prefix)).toBe(true);
      for (const suffix of ["-extra", ":extra", "/extra", "%extra"]) {
        const otherKey = questionAttachmentDraftKey(
          environment,
          ThreadId.make(`${threadId}${suffix}`),
          requestId,
          "question:1",
        );
        expect(otherKey.startsWith(prefix)).toBe(false);
        expect(composerDraftEnvironmentId(otherKey, [environment], [])).toBe(environment);
      }
    }
  });
  it("resolves thread, new-task, and queued-task drafts without crossing environments", () => {
    expect(composerDraftEnvironmentId("environment-1:thread", [environmentId], [])).toBe(
      environmentId,
    );
    expect(composerDraftEnvironmentId("new-task:environment-1:project", [], [])).toBe(
      environmentId,
    );
    expect(
      composerDraftEnvironmentId(
        "pending-task:message",
        [],
        [{ messageId: "message", environmentId }],
      ),
    ).toBe(environmentId);
    expect(composerDraftEnvironmentId("pending-task:missing", [], [])).toBeNull();
    const colonEnvironment = EnvironmentId.make("a:vcs-status:b");
    expect(
      composerDraftEnvironmentId(
        `${colonEnvironment}:thread`,
        [EnvironmentId.make("a"), colonEnvironment],
        [],
      ),
    ).toBe(colonEnvironment);
    expect(composerDraftEnvironmentId(`new-task:${colonEnvironment}:project`, [], [])).toBe(
      colonEnvironment,
    );
  });

  it("reads an id-keyed new-task draft's environment from its project stamp", () => {
    const stamped = {
      project: {
        environmentId,
        projectId: "project" as never,
        createdAt: "2026-09-05T00:00:00.000Z",
      },
    };
    expect(composerDraftEnvironmentId("new-task:abc123-def456", [], [], stamped)).toBe(
      environmentId,
    );
    expect(composerDraftEnvironmentId("new-task:abc123-def456", [], [])).toBeNull();
    expect(composerDraftEnvironmentId("new-task:environment-2:project", [], [], stamped)).toBe(
      environmentId,
    );
  });

  it("only a failed upload blocks sending; an in-flight one queues instead", () => {
    const key = composerAttachmentUploadKey(environmentId, "file");
    const input = {
      environmentId,
      attachments: [request("file").attachment],
      connected: true,
      serverConfig: {
        environment: {
          capabilities: { fileAttachments: { maxUploadBytes: 1024 } },
        },
      },
      states: {},
    };
    expect(composerAttachmentUploadBlockReason(input)).toBeNull();
    expect(composerAttachmentsStillUploading(input)).toBe(true);
    expect(
      composerAttachmentsStillUploading({
        ...input,
        states: { [key]: { status: "uploading", progress: 0.6 } },
      }),
    ).toBe(true);
    expect(composerAttachmentUploadBlockReason({ ...input, connected: false })).toBeNull();
    expect(
      composerAttachmentUploadBlockReason({
        ...input,
        states: { [key]: { status: "failed", reason: "Offline" } },
      }),
    ).toBe("Retry or remove the failed attachment");
    expect(
      composerAttachmentsStillUploading({
        ...input,
        states: { [key]: { status: "failed", reason: "Offline" } },
      }),
    ).toBe(false);
    expect(
      composerAttachmentUploadBlockReason({ ...input, states: { [key]: { status: "ready" } } }),
    ).toBeNull();
    expect(
      composerAttachmentsStillUploading({ ...input, states: { [key]: { status: "ready" } } }),
    ).toBe(false);
    expect(composerAttachmentsStillUploading({ ...input, serverConfig: null })).toBe(false);
  });
});
