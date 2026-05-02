import "../index.css";

import { scopeThreadRef } from "@t3tools/client-runtime";
import { EnvironmentId, type MessageId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { GlobalThreadSearchDialog } from "./GlobalThreadSearchDialog";
import type { Project, Thread } from "../types";

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

function createThread(input: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  messages?: Thread["messages"];
  proposedPlans?: Thread["proposedPlans"];
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
    proposedPlans: input.proposedPlans ?? [],
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
      title: "Queue recovery plan",
      createdAt: "2026-04-16T12:00:00.000Z",
      updatedAt: "2026-04-16T12:05:00.000Z",
      messages: [
        {
          id: "message-title" as MessageId,
          role: "user",
          text: "Ship the release today",
          createdAt: "2026-04-16T12:01:00.000Z",
          streaming: false,
        },
      ],
    }),
    createThread({
      id: "thread-plan",
      title: "Incident notes",
      createdAt: "2026-04-16T12:00:00.000Z",
      updatedAt: "2026-04-16T12:06:00.000Z",
      proposedPlans: [
        {
          id: "plan-1" as Thread["proposedPlans"][number]["id"],
          turnId: null,
          planMarkdown: "Investigate the queue recovery path overnight.",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-04-16T12:02:00.000Z",
          updatedAt: "2026-04-16T12:02:00.000Z",
        },
      ],
    }),
  ];

  const onOpenChange = vi.fn();
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <GlobalThreadSearchDialog
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

describe("GlobalThreadSearchDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    navigateSpy.mockReset();
  });

  it("searches across titles and plan content and navigates to the selected thread", async () => {
    await using _mounted = await mountDialog();

    await page.getByTestId("global-thread-search-input").fill("queue");

    await vi.waitFor(() => {
      const results = Array.from(
        document.querySelectorAll<HTMLElement>('[data-global-thread-search-result="true"]'),
      );
      expect(results).toHaveLength(2);
      expect(results[0]?.textContent).toContain("Queue recovery plan");
      expect(results[1]?.textContent).toContain("Incident notes");
    });

    await page.getByRole("button", { name: /Incident notes/i }).click();

    expect(navigateSpy).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: {
        environmentId: ENVIRONMENT_ID,
        threadId: "thread-plan",
      },
    });
  });

  it("closes without navigating when selecting the active thread", async () => {
    await using mounted = await mountDialog({
      activeThreadRef: scopeThreadRef(ENVIRONMENT_ID, "thread-title" as ThreadId),
    });

    await page.getByTestId("global-thread-search-input").fill("queue");
    await page.getByRole("button", { name: /Queue recovery plan/i }).click();

    expect(navigateSpy).not.toHaveBeenCalled();
    expect(mounted.onOpenChange).toHaveBeenCalledWith(false);
  });
});
