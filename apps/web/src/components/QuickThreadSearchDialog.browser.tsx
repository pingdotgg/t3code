import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, type MessageId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { QuickThreadSearchDialog } from "./QuickThreadSearchDialog";
import type { ChatMessage, Project, Thread } from "../types";

const navigateSpy = vi.fn();

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = "project-1" as ProjectId;

function createUserMessage(id: string, text: string, createdAt: string): ChatMessage {
  return {
    id: id as MessageId,
    role: "user",
    text,
    createdAt,
    streaming: false,
  };
}

function createThread(input: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messages?: ChatMessage[];
}): Thread {
  return {
    id: input.id as ThreadId,
    environmentId: ENVIRONMENT_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: input.title,
    modelSelection: {
      instanceId: "codex" as any,
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: input.messages ?? [],
    proposedPlans: [],
    error: null,
    createdAt: input.createdAt,
    archivedAt: null,
    updatedAt: input.updatedAt ?? input.createdAt,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
  };
}

async function mountDialog(input?: {
  threads?: readonly Thread[];
  activeThreadRef?: ReturnType<typeof scopeThreadRef> | null;
}) {
  const projects: Project[] = [
    {
      id: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      name: "Project",
      cwd: "/repo/project",
      defaultModelSelection: null,
      scripts: [],
    },
  ];

  const threads = input?.threads ?? [
    createThread({
      id: "thread-title",
      title: "Debug flaky build",
      createdAt: "2026-04-16T12:00:00.000Z",
      updatedAt: "2026-04-16T12:05:00.000Z",
      messages: [
        createUserMessage("message-title", "Help me ship this branch", "2026-04-16T12:01:00.000Z"),
      ],
    }),
    createThread({
      id: "thread-prompt",
      title: "Release checklist",
      createdAt: "2026-04-16T12:00:00.000Z",
      updatedAt: "2026-04-16T12:06:00.000Z",
      messages: [
        createUserMessage(
          "message-prompt",
          "Please debug why the queue stalled overnight",
          "2026-04-16T12:02:00.000Z",
        ),
      ],
    }),
  ];

  const onOpenChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <QuickThreadSearchDialog
      open={true}
      focusRequestId={1}
      threads={threads}
      projects={projects}
      activeThreadRef={input?.activeThreadRef ?? null}
      onOpenChange={onOpenChange}
    />,
    { container: host },
  );

  const cleanup = async () => {
    await screen.unmount();
    host.remove();
  };

  return {
    [Symbol.asyncDispose]: cleanup,
    cleanup,
    onOpenChange,
  };
}

describe("QuickThreadSearchDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    navigateSpy.mockReset();
  });

  it("shows title matches ahead of prompt-only matches and navigates on click", async () => {
    await using _mounted = await mountDialog();

    await page.getByTestId("quick-thread-search-input").fill("debug");

    await vi.waitFor(() => {
      const results = Array.from(
        document.querySelectorAll<HTMLElement>('[data-quick-thread-search-result="true"]'),
      );
      expect(results).toHaveLength(2);
      expect(results[0]?.textContent).toContain("Debug flaky build");
      expect(results[1]?.textContent).toContain("Release checklist");
    });

    await page.getByRole("button", { name: /Debug flaky build/i }).click();

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: ENVIRONMENT_ID,
        threadId: "thread-title",
      },
    });
  });

  it("shows a no-results state and avoids navigating for the active thread", async () => {
    await using mounted = await mountDialog({
      threads: [
        createThread({
          id: "thread-active",
          title: "Release checklist",
          createdAt: "2026-04-16T12:00:00.000Z",
          messages: [
            createUserMessage(
              "message-active",
              "Launch checklist for today",
              "2026-04-16T12:01:00.000Z",
            ),
          ],
        }),
      ],
      activeThreadRef: scopeThreadRef(ENVIRONMENT_ID, "thread-active" as ThreadId),
    });

    await page.getByTestId("quick-thread-search-input").fill("missing");
    await expect
      .element(page.getByText("No recent threads matched this search."))
      .toBeInTheDocument();

    await page.getByTestId("quick-thread-search-input").fill("release");
    await page.getByRole("button", { name: /Release checklist/i }).click();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });
});
