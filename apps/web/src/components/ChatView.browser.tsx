import "../index.css";

import {
  ORCHESTRATION_WS_METHODS,
  type MessageId,
  type OrchestrationReadModel,
  type ProjectId,
  type ProviderSessionId,
  type ServerConfig,
  type ThreadId,
  type WsWelcomePayload,
  WS_CHANNELS,
  WS_METHODS,
} from "@t3tools/contracts";
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { HttpResponse, http, ws } from "msw";
import { setupWorker } from "msw/browser";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { getRouter } from "../router";
import { useStore } from "../store";
import { estimateTimelineMessageHeight } from "./timelineHeight";

const THREAD_ID = "thread-browser-test" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;
const NOW_ISO = "2026-03-04T12:00:00.000Z";
const BASE_TIME_MS = Date.parse(NOW_ISO);
const ATTACHMENT_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='120' height='300'></svg>";

interface WsRequestEnvelope {
  id: string;
  body: {
    _tag: string;
    [key: string]: unknown;
  };
}

interface TestFixture {
  snapshot: OrchestrationReadModel;
  serverConfig: ServerConfig;
  welcome: WsWelcomePayload;
}

let fixture: TestFixture;
const wsLink = ws.link(/ws(s)?:\/\/.*/);

function isoAt(offsetSeconds: number): string {
  return new Date(BASE_TIME_MS + offsetSeconds * 1_000).toISOString();
}

function createBaseServerConfig(): ServerConfig {
  return {
    cwd: "/repo/project",
    keybindingsConfigPath: "/repo/project/.t3code-keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        provider: "codex",
        status: "ready",
        available: true,
        authStatus: "authenticated",
        checkedAt: NOW_ISO,
      },
    ],
    availableEditors: [],
  };
}

function createUserMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
  attachments?: Array<{
    type: "image";
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
}) {
  return {
    id: options.id,
    role: "user" as const,
    text: options.text,
    ...(options.attachments ? { attachments: options.attachments } : {}),
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createAssistantMessage(options: {
  id: MessageId;
  text: string;
  offsetSeconds: number;
}) {
  return {
    id: options.id,
    role: "assistant" as const,
    text: options.text,
    turnId: null,
    streaming: false,
    createdAt: isoAt(options.offsetSeconds),
    updatedAt: isoAt(options.offsetSeconds + 1),
  };
}

function createSnapshotForTargetUser(options: {
  targetMessageId: MessageId;
  targetText: string;
  targetAttachmentCount?: number;
}): OrchestrationReadModel {
  const messages: Array<OrchestrationReadModel["threads"][number]["messages"][number]> = [];

  for (let index = 0; index < 22; index += 1) {
    const isTarget = index === 3;
    const userId = `msg-user-${index}` as MessageId;
    const assistantId = `msg-assistant-${index}` as MessageId;
    const attachments =
      isTarget && (options.targetAttachmentCount ?? 0) > 0
        ? Array.from({ length: options.targetAttachmentCount ?? 0 }, (_, attachmentIndex) => ({
            type: "image" as const,
            id: `attachment-${attachmentIndex + 1}`,
            name: `attachment-${attachmentIndex + 1}.png`,
            mimeType: "image/png",
            sizeBytes: 128,
          }))
        : undefined;

    messages.push(
      createUserMessage({
        id: isTarget ? options.targetMessageId : userId,
        text: isTarget ? options.targetText : `filler user message ${index}`,
        offsetSeconds: messages.length * 3,
        ...(attachments ? { attachments } : {}),
      }),
    );
    messages.push(
      createAssistantMessage({
        id: assistantId,
        text: `assistant filler ${index}`,
        offsetSeconds: messages.length * 3,
      }),
    );
  }

  return {
    snapshotSequence: 1,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repo/project",
        defaultModel: "gpt-5",
        scripts: [],
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Browser test thread",
        model: "gpt-5",
        branch: "main",
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW_ISO,
        updatedAt: NOW_ISO,
        deletedAt: null,
        messages,
        activities: [],
        checkpoints: [],
        session: {
          threadId: THREAD_ID,
          status: "ready",
          providerName: "codex",
          providerSessionId: "session-1" as ProviderSessionId,
          providerThreadId: null,
          approvalPolicy: "on-failure",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW_ISO,
        },
      },
    ],
    updatedAt: NOW_ISO,
  };
}

function buildFixture(snapshot: OrchestrationReadModel): TestFixture {
  return {
    snapshot,
    serverConfig: createBaseServerConfig(),
    welcome: {
      cwd: "/repo/project",
      projectName: "Project",
      bootstrapProjectId: PROJECT_ID,
      bootstrapThreadId: THREAD_ID,
    },
  };
}

function resolveWsRpc(tag: string): unknown {
  if (tag === ORCHESTRATION_WS_METHODS.getSnapshot) {
    return fixture.snapshot;
  }
  if (tag === WS_METHODS.serverGetConfig) {
    return fixture.serverConfig;
  }
  if (tag === WS_METHODS.gitListBranches) {
    return {
      isRepo: true,
      branches: [
        {
          name: "main",
          current: true,
          isDefault: true,
          worktreePath: null,
        },
      ],
    };
  }
  if (tag === WS_METHODS.gitStatus) {
    return {
      branch: "main",
      hasWorkingTreeChanges: false,
      workingTree: {
        files: [],
        insertions: 0,
        deletions: 0,
      },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  }
  if (tag === WS_METHODS.projectsSearchEntries) {
    return {
      entries: [],
      truncated: false,
    };
  }
  return {};
}

const worker = setupWorker(
  wsLink.addEventListener("connection", ({ client }) => {
    client.send(
      JSON.stringify({
        type: "push",
        channel: WS_CHANNELS.serverWelcome,
        data: fixture.welcome,
      }),
    );
    client.addEventListener("message", (event) => {
      const rawData = event.data;
      if (typeof rawData !== "string") return;
      let request: WsRequestEnvelope;
      try {
        request = JSON.parse(rawData) as WsRequestEnvelope;
      } catch {
        return;
      }
      const method = request.body?._tag;
      if (typeof method !== "string") return;
      client.send(
        JSON.stringify({
          id: request.id,
          result: resolveWsRpc(method),
        }),
      );
    });
  }),
  http.get("*/attachments/:attachmentId", () =>
    HttpResponse.text(ATTACHMENT_SVG, {
      headers: {
        "Content-Type": "image/svg+xml",
      },
    }),
  ),
  http.get("*/api/project-favicon", () => new HttpResponse(null, { status: 204 })),
);

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function waitForLayout(): Promise<void> {
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

async function waitForElement<T extends Element>(
  query: () => T | null,
  errorMessage: string,
): Promise<T> {
  const timeoutAt = performance.now() + 8_000;
  while (performance.now() < timeoutAt) {
    const element = query();
    if (element) return element;
    await nextFrame();
  }
  throw new Error(errorMessage);
}

async function waitForImagesToLoad(scope: ParentNode): Promise<void> {
  const images = Array.from(scope.querySelectorAll("img"));
  if (images.length === 0) {
    return;
  }
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) {
            resolve();
            return;
          }
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        }),
    ),
  );
  await waitForLayout();
}

async function renderAndMeasureUserRow(options: {
  timelineWidthPx: number;
  targetMessageId: MessageId;
  snapshot: OrchestrationReadModel;
}): Promise<{
  measuredRowHeightPx: number;
  timelineWidthMeasuredPx: number;
  renderedInVirtualizedRegion: boolean;
}> {
  fixture = buildFixture(options.snapshot);

  const host = document.createElement("div");
  host.style.width = `${options.timelineWidthPx}px`;
  host.style.height = "920px";
  host.style.display = "flex";
  host.style.overflow = "hidden";
  document.body.append(host);

  const router = getRouter(
    createMemoryHistory({
      initialEntries: [`/${THREAD_ID}`],
    }),
  );

  const root: Root = createRoot(host);
  root.render(<RouterProvider router={router} />);

  try {
    await waitForLayout();

    const scrollContainer = await waitForElement(
      () => host.querySelector<HTMLDivElement>("div.overflow-y-auto.overscroll-y-contain"),
      "Unable to find ChatView message scroll container.",
    );

    let row: HTMLElement | null = null;
    const timeoutAt = performance.now() + 8_000;
  while (performance.now() < timeoutAt) {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await waitForLayout();
      row = host.querySelector<HTMLElement>(
        `[data-message-id="${options.targetMessageId}"][data-message-role="user"]`,
      );
      if (row) {
        break;
      }
    }
    if (!row) {
      throw new Error("Unable to locate targeted user message row.");
    }

    await waitForImagesToLoad(row);
    scrollContainer.scrollTop = 0;
    scrollContainer.dispatchEvent(new Event("scroll"));
    await nextFrame();

    const timelineRoot =
      row.closest<HTMLElement>('[data-timeline-root="true"]') ??
      host.querySelector<HTMLElement>('[data-timeline-root="true"]');
    if (!(timelineRoot instanceof HTMLElement)) {
      throw new Error("Unable to locate timeline root container.");
    }

    const timelineWidthMeasuredPx = timelineRoot.getBoundingClientRect().width;
    let measuredRowHeightPx = 0;
    let renderedInVirtualizedRegion = false;
    const rowSelector = `[data-message-id="${options.targetMessageId}"][data-message-role="user"]`;
    const measureTimeoutAt = performance.now() + 4_000;
    while (performance.now() < measureTimeoutAt) {
      scrollContainer.scrollTop = 0;
      scrollContainer.dispatchEvent(new Event("scroll"));
      await nextFrame();
      const measuredRow = host.querySelector<HTMLElement>(rowSelector);
      if (!measuredRow) {
        continue;
      }
      measuredRowHeightPx = measuredRow.getBoundingClientRect().height;
      renderedInVirtualizedRegion = measuredRow.closest("[data-index]") instanceof HTMLElement;
      if (measuredRowHeightPx > 0) {
        break;
      }
    }
    if (measuredRowHeightPx <= 0) {
      throw new Error("Unable to measure targeted user row height.");
    }

    return { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion };
  } finally {
    root.unmount();
    host.remove();
  }
}

describe("ChatView timeline estimator parity (full app)", () => {
  beforeAll(async () => {
    fixture = buildFixture(
      createSnapshotForTargetUser({
        targetMessageId: "msg-user-bootstrap" as MessageId,
        targetText: "bootstrap",
      }),
    );
    await worker.start({
      onUnhandledRequest: "bypass",
      quiet: true,
      serviceWorker: {
        url: "/mockServiceWorker.js",
      },
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    useStore.setState({
      projects: [],
      threads: [],
      threadsHydrated: false,
      runtimeMode: "full-access",
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps long user message estimate close to actual rendered virtualized ChatView row height", async () => {
    const userText = "x".repeat(3_200);
    const targetMessageId = "msg-user-target-long" as MessageId;
    const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
      await renderAndMeasureUserRow({
        timelineWidthPx: 960,
        targetMessageId,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
        }),
      });

    expect(renderedInVirtualizedRegion).toBe(true);

    const estimatedHeightPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: timelineWidthMeasuredPx },
    );

    expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(44);
  });

  it("tracks additional rendered wrapping when ChatView width narrows", async () => {
    const userText = "x".repeat(2_400);
    const targetMessageId = "msg-user-target-wrap" as MessageId;
    const snapshot = createSnapshotForTargetUser({
      targetMessageId,
      targetText: userText,
    });
    const desktop = await renderAndMeasureUserRow({
      timelineWidthPx: 960,
      targetMessageId,
      snapshot,
    });
    const mobile = await renderAndMeasureUserRow({
      timelineWidthPx: 360,
      targetMessageId,
      snapshot,
    });

    const estimatedDesktopPx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: desktop.timelineWidthMeasuredPx },
    );
    const estimatedMobilePx = estimateTimelineMessageHeight(
      { role: "user", text: userText, attachments: [] },
      { timelineWidthPx: mobile.timelineWidthMeasuredPx },
    );

    const measuredDeltaPx = mobile.measuredRowHeightPx - desktop.measuredRowHeightPx;
    const estimatedDeltaPx = estimatedMobilePx - estimatedDesktopPx;
    expect(measuredDeltaPx).toBeGreaterThan(0);
    expect(estimatedDeltaPx).toBeGreaterThan(0);
    const ratio = estimatedDeltaPx / measuredDeltaPx;
    expect(ratio).toBeGreaterThan(0.65);
    expect(ratio).toBeLessThan(1.35);
  });

  it("keeps user attachment estimate close to actual rendered ChatView row height", async () => {
    const targetMessageId = "msg-user-target-attachments" as MessageId;
    const userText = "message with image attachments";
    const { measuredRowHeightPx, timelineWidthMeasuredPx, renderedInVirtualizedRegion } =
      await renderAndMeasureUserRow({
        timelineWidthPx: 960,
        targetMessageId,
        snapshot: createSnapshotForTargetUser({
          targetMessageId,
          targetText: userText,
          targetAttachmentCount: 3,
        }),
      });

    expect(renderedInVirtualizedRegion).toBe(true);

    const estimatedHeightPx = estimateTimelineMessageHeight(
      {
        role: "user",
        text: userText,
        attachments: [{ id: "attachment-1" }, { id: "attachment-2" }, { id: "attachment-3" }],
      },
      { timelineWidthPx: timelineWidthMeasuredPx },
    );

    expect(Math.abs(measuredRowHeightPx - estimatedHeightPx)).toBeLessThanOrEqual(56);
  });
});
