import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";

import {
  clearAllSessionOptimizerAttachments,
  clearSessionOptimizerAttachments,
  isCurrentSessionOptimizerAttachments,
  readSessionOptimizerAttachments,
  removeSessionOptimizerAttachment,
  setSessionOptimizerAttachments,
} from "@t3tools/provider-core/server/sessionOptimizerAttachments";

import { resolveInstallableSessionOptimizers } from "./SessionOptimizerAttachments.ts";

describe("SessionOptimizerAttachments", () => {
  it("selects only installed optimizers supported by the adapter", () => {
    const statuses = [
      {
        id: "rtk" as const,
        installed: true,
        version: "0.23.0",
        mode: "cli-wrapper" as const,
        checkedAt: "1970-01-01T00:00:00.000Z",
      },
      {
        id: "headroom" as const,
        installed: true,
        version: "1.0.0",
        running: true,
        mode: "detected-proxy" as const,
        checkedAt: "1970-01-01T00:00:00.000Z",
      },
      {
        id: "cbm" as const,
        installed: true,
        version: "1.0.0",
        mode: "stdio-mcp" as const,
        checkedAt: "1970-01-01T00:00:00.000Z",
      },
    ];
    const settings = { rtk: true, headroom: true, cbm: true };

    expect(
      resolveInstallableSessionOptimizers({
        settings,
        capabilities: { rtk: true, headroom: true, cbm: true },
        statuses,
      }),
    ).toEqual({ configured: ["rtk", "headroom", "cbm"], rtk: true, headroom: true, cbm: true });
    expect(
      resolveInstallableSessionOptimizers({
        settings,
        capabilities: { rtk: false, headroom: true, cbm: true },
        statuses,
      }),
    ).toEqual({ configured: ["rtk", "headroom", "cbm"], rtk: false, headroom: true, cbm: true });
  });

  it("keeps attachments isolated by thread and clears them reliably", () => {
    const firstThread = ThreadId.make("thread-first");
    const secondThread = ThreadId.make("thread-second");

    clearAllSessionOptimizerAttachments();
    setSessionOptimizerAttachments(firstThread, {
      projectId: ProjectId.make("project-first"),
      cwd: "/repo/first",
      configured: ["rtk", "cbm"],
      attached: ["rtk", "cbm"],
      ready: ["rtk", "cbm"],
      rtk: { command: "rtk" },
      cbm: {
        command: "/tools/codebase-memory-mcp",
        args: [],
        env: { CBM_ALLOWED_ROOT: "/repo/first" },
      },
    });
    setSessionOptimizerAttachments(secondThread, {
      projectId: ProjectId.make("project-second"),
      cwd: "/repo/second",
      configured: [],
      attached: [],
      ready: [],
    });

    expect(readSessionOptimizerAttachments(firstThread)).toMatchObject({
      projectId: "project-first",
      cwd: "/repo/first",
      attached: ["rtk", "cbm"],
    });
    expect(readSessionOptimizerAttachments(secondThread)?.attached).toEqual([]);

    clearSessionOptimizerAttachments(firstThread);
    expect(readSessionOptimizerAttachments(firstThread)).toBeUndefined();
    expect(readSessionOptimizerAttachments(secondThread)).toBeDefined();

    removeSessionOptimizerAttachment(secondThread, "cbm");
    expect(readSessionOptimizerAttachments(secondThread)).toMatchObject({
      configured: [],
      attached: [],
      ready: [],
    });

    clearAllSessionOptimizerAttachments();
    expect(readSessionOptimizerAttachments(secondThread)).toBeUndefined();
  });

  it("invalidates old session identities and removes unsupported attachments", () => {
    const threadId = ThreadId.make("thread-restarted");
    const first = {
      projectId: ProjectId.make("project-restarted"),
      cwd: "/repo/restarted",
      configured: ["rtk", "headroom", "cbm"] as const,
      attached: ["rtk", "headroom", "cbm"] as const,
      ready: ["rtk", "headroom"] as const,
      rtk: { command: "rtk" as const },
      headroom: {
        environment: { OPENAI_BASE_URL: "http://127.0.0.1:6767/v1" },
        codexConfig: { openai_base_url: "http://127.0.0.1:6767/v1" },
      },
      cbm: {
        command: "codebase-memory-mcp",
        args: [],
        env: { CBM_ALLOWED_ROOT: "/repo/restarted" },
      },
    };
    setSessionOptimizerAttachments(threadId, first);
    setSessionOptimizerAttachments(threadId, {
      ...first,
      attached: ["cbm"],
      ready: [],
    });

    expect(isCurrentSessionOptimizerAttachments(threadId, first)).toBe(false);
    removeSessionOptimizerAttachment(threadId, "cbm");
    expect(readSessionOptimizerAttachments(threadId)).toMatchObject({
      configured: ["rtk", "headroom", "cbm"],
      attached: [],
      ready: [],
    });
    expect(readSessionOptimizerAttachments(threadId)).not.toHaveProperty("cbm");

    removeSessionOptimizerAttachment(threadId, "headroom");
    expect(readSessionOptimizerAttachments(threadId)).not.toHaveProperty("headroom");

    clearSessionOptimizerAttachments(threadId);
  });
});
