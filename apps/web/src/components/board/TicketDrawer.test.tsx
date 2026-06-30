import { MessageId, ProjectId, TicketId } from "@t3tools/contracts";
import type { ComponentType, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { TicketDiffContent } from "./TicketDiff";
import { TicketDrawer, isTicketSourceOwned } from "./TicketDrawer";

vi.mock("@pierre/diffs/react", () => {
  const FileDiff = (props: {
    fileDiff: { name?: string | null; prevName?: string | null };
    renderHeaderPrefix?: () => ReactNode;
  }) => (
    <div data-testid="file-diff">
      {props.renderHeaderPrefix?.()}
      {props.fileDiff.name ?? props.fileDiff.prevName ?? "diff"}
    </div>
  );

  return { FileDiff };
});

const ticketDetail = {
  ticket: {
    ticketId: "ticket-1",
    boardId: "board-1",
    title: "Review release blockers",
    description: "Check the compatibility risk before shipping.",
    currentLaneKey: "review",
    status: "waiting_on_user",
  },
  steps: [
    {
      stepRunId: "step-1",
      stepKey: "agent-review",
      stepType: "agent",
      status: "awaiting_user",
      waitingReason: "Approve the proposed fix",
      providerResponseKind: "user-input",
    },
    {
      stepRunId: "step-2",
      stepKey: "ship",
      stepType: "approval",
      status: "awaiting_user",
      waitingReason: "Ship this release?",
      providerResponseKind: "request",
    },
  ],
  messages: [
    {
      messageId: MessageId.make("message-agent"),
      ticketId: "ticket-1",
      stepRunId: "step-1",
      author: "agent",
      body: "Should I change the websocket payload guard?",
      attachments: [],
      createdAt: "2026-06-08T14:00:00.000Z",
    },
    {
      messageId: MessageId.make("message-user"),
      ticketId: "ticket-1",
      stepRunId: "step-1",
      author: "user",
      body: "Yes, preserve old clients too.",
      attachments: [
        {
          kind: "image",
          id: "image-1",
          name: "payload.png",
          mimeType: "image/png",
          sizeBytes: 7,
          dataUrl: "data:image/png;base64,cGF5bG9hZA==",
        },
      ],
      createdAt: "2026-06-08T14:01:00.000Z",
    },
  ],
} as const;

describe("isTicketSourceOwned", () => {
  it("returns false when syncedSource is absent", () => {
    expect(isTicketSourceOwned({ syncedSource: undefined })).toBe(false);
  });

  it("returns true when syncedSource is present", () => {
    expect(
      isTicketSourceOwned({
        syncedSource: { provider: "github", url: "https://github.com/o/r/issues/1" },
      }),
    ).toBe(true);
  });
});

describe("TicketDrawer", () => {
  it("renders ticket metadata, the message thread, the reply composer, and approval gates", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).toContain("Review release blockers");
    expect(markup).toContain("Check the compatibility risk before shipping.");
    expect(markup).toContain("agent-review");
    expect(markup).toContain("awaiting user");
    expect(markup).toContain("Approve the proposed fix");
    expect(markup).toContain("Should I change the websocket payload guard?");
    expect(markup).toContain("Yes, preserve old clients too.");
    expect(markup).toContain("payload.png");
    expect(markup).toContain("Ticket reply");
    expect(markup).toContain("Send reply");
    expect(markup).toContain("Edit ticket");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).toContain("Run lane");
  });

  it("renders an edited indicator for messages with editedAt and omits it otherwise", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          messages: [
            {
              messageId: MessageId.make("message-edited"),
              ticketId: "ticket-1",
              author: "user",
              body: "Edited body text.",
              attachments: [],
              createdAt: "2026-06-08T14:01:00.000Z",
              editedAt: "2026-06-08T14:05:00.000Z",
            },
            {
              messageId: MessageId.make("message-plain"),
              ticketId: "ticket-1",
              author: "user",
              body: "Unedited body text.",
              attachments: [],
              createdAt: "2026-06-08T14:02:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Edited body text.");
    expect(markup).toContain("Unedited body text.");
    expect(markup).toContain("· edited");
    // Only the edited message should carry the indicator.
    expect(markup.match(/· edited/g)?.length).toBe(1);
  });

  it("shows an Edit button only for the user's own comments (stepRunId == null)", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          messages: [
            {
              messageId: MessageId.make("message-own"),
              ticketId: "ticket-1",
              author: "user",
              body: "My own comment.",
              attachments: [],
              createdAt: "2026-06-08T14:00:00.000Z",
            },
            {
              messageId: MessageId.make("message-answer"),
              ticketId: "ticket-1",
              stepRunId: "step-1",
              author: "user",
              body: "Answer to an agent step.",
              attachments: [],
              createdAt: "2026-06-08T14:01:00.000Z",
            },
            {
              messageId: MessageId.make("message-agent"),
              ticketId: "ticket-1",
              author: "agent",
              body: "Agent reply.",
              attachments: [],
              createdAt: "2026-06-08T14:02:00.000Z",
            },
          ],
        }}
        onApprove={async () => undefined}
        onEditMessage={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    // Exactly one Edit-message button — for the standalone user comment only.
    expect(markup.match(/aria-label="Edit comment"/g)?.length).toBe(1);
  });

  it("explains why the ticket is in its lane and lists the route history", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          routeHistory: [
            {
              occurredAt: "2026-06-08T13:00:00.000Z",
              toLane: "implement",
              source: "manual",
            },
            {
              occurredAt: "2026-06-08T14:00:00.000Z",
              fromLane: "implement",
              toLane: "review",
              source: "lane_transition",
              matchedTransitionIndex: 1,
              pipelineResult: "success",
              laneRunCount: 2,
              steps: {
                verdict: { status: "completed", exitCode: 0, verdict: "approve" },
              },
            },
          ],
        }}
        lanes={[
          { key: "implement", name: "Implementation", entry: "auto", pipelineStepCount: 1 },
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 },
        ]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Why is this ticket here?");
    expect(markup).toContain("Implementation → Review");
    expect(markup).toContain("Matched transition #2");
    expect(markup).toContain("verdict: approve");
    expect(markup).toContain("Route history (2)");
    expect(markup).toContain("Moved manually");
  });

  it("renders captured step output with a verdict badge", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-verdict",
              stepKey: "review",
              stepType: "agent",
              status: "completed",
              waitingReason: null,
              output: { verdict: "revise", notes: "Tighten the error handling." },
            },
          ],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("verdict: revise");
    expect(markup).toContain("Tighten the error handling.");
  });

  it("shows approval actions instead of the reply composer for provider approval requests", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-provider-request",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Approve this command?",
              providerResponseKind: "request",
            },
          ],
          messages: [],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Approve this command?");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
    expect(markup).not.toContain("Ticket reply");
    expect(markup).not.toContain("Send reply");
  });

  it("shows the reply composer for provider user-input requests", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          steps: [
            {
              stepRunId: "step-provider-question",
              stepKey: "agent-review",
              stepType: "agent",
              status: "awaiting_user",
              waitingReason: "Which API should I use?",
              providerResponseKind: "user-input",
            },
          ],
          messages: [],
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Which API should I use?");
    expect(markup).toContain("Ticket reply");
    expect(markup).toContain("Send reply");
    expect(markup).not.toContain("Approve");
    expect(markup).not.toContain("Reject");
  });

  it("renders ticket image attachments without direct data-url links", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).toContain('src="data:image/png;base64,cGF5bG9hZA=="');
    expect(markup).not.toContain('href="data:image/png');
  });

  it("disables Run lane when the current lane has no manual pipeline", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={ticketDetail}
        lanes={[
          { key: "review", name: "Review", entry: "manual", pipelineStepCount: 0 },
          { key: "implement", name: "Implement", entry: "auto", pipelineStepCount: 2 },
        ]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain('title="This lane has no manual pipeline to run."');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>.*Run lane<\/button>/s);
  });

  it("renders script steps with read-only logs and operational badges", () => {
    const Drawer = TicketDrawer as ComponentType<
      Parameters<typeof TicketDrawer>[0] & { readonly projectId: ProjectId }
    >;
    const markup = renderToStaticMarkup(
      <Drawer
        api={
          {
            terminal: {
              attachHistory: () => () => undefined,
            },
          } as never
        }
        projectId={ProjectId.make("project-1")}
        detail={{
          ticket: {
            ticketId: "ticket-1",
            boardId: "board-1",
            title: "Review release blockers",
            currentLaneKey: "review",
            status: "blocked",
          },
          steps: [
            {
              stepRunId: "step-running",
              stepKey: "tests",
              stepType: "script",
              status: "running",
              waitingReason: null,
              blockedReason: null,
              scriptThreadId: "script-thread-1",
              terminalId: "script-terminal-1",
              scriptStatus: "running",
              exitCode: null,
              signal: null,
            },
            {
              stepRunId: "step-failed",
              stepKey: "lint",
              stepType: "script",
              status: "failed",
              waitingReason: null,
              blockedReason: null,
              scriptThreadId: "script-thread-2",
              terminalId: "script-terminal-2",
              scriptStatus: "exited",
              exitCode: 2,
              signal: null,
            },
            {
              stepRunId: "step-blocked",
              stepKey: "trust",
              stepType: "script",
              status: "blocked",
              waitingReason: null,
              blockedReason: "Project not trusted to run scripts",
              scriptThreadId: null,
              terminalId: null,
              scriptStatus: null,
              exitCode: null,
              signal: null,
            },
          ],
        }}
        lanes={[{ key: "review", name: "Review", entry: "manual", pipelineStepCount: 3 }]}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Script output");
    expect(markup).toContain("running");
    expect(markup).toContain("exit 2");
    expect(markup).toContain("blocked");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Trust this project &amp; run");
  });
});

describe("TicketDrawer synced-source badge", () => {
  it("shows Synced from badge and hides Edit button when syncedSource is set", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer
        detail={{
          ...ticketDetail,
          syncedSource: {
            provider: "github",
            url: "https://github.com/owner/repo/issues/42",
          },
        }}
        onApprove={async () => undefined}
        onRunLane={() => {}}
      />,
    );

    expect(markup).toContain("Synced from github");
    expect(markup).toContain("https://github.com/owner/repo/issues/42");
    expect(markup).not.toContain("Edit ticket");
  });

  it("shows Edit ticket button when syncedSource is absent", () => {
    const markup = renderToStaticMarkup(
      <TicketDrawer detail={ticketDetail} onApprove={async () => undefined} onRunLane={() => {}} />,
    );

    expect(markup).not.toContain("Synced from");
    expect(markup).toContain("Edit ticket");
  });
});

describe("TicketDiffContent", () => {
  it("renders file summaries and the parsed patch viewer", () => {
    const markup = renderToStaticMarkup(
      <TicketDiffContent
        diff={{
          ticketId: TicketId.make("ticket-1"),
          baseRef: "refs/workflow/tickets/ticket-1/base",
          truncated: false,
          files: [{ path: "src/workflow.ts", additions: 4, deletions: 1 }],
          patch:
            "diff --git a/src/workflow.ts b/src/workflow.ts\n" +
            "index 1111111..2222222 100644\n" +
            "--- a/src/workflow.ts\n" +
            "+++ b/src/workflow.ts\n" +
            "@@ -1 +1 @@\n" +
            "-old\n" +
            "+new\n",
        }}
        resolvedTheme="light"
      />,
    );

    expect(markup).toContain("refs/workflow/tickets/ticket-1/base");
    expect(markup).toContain("src/workflow.ts");
    expect(markup).toContain("+4");
    expect(markup).toContain("-1");
    expect(markup).toContain("file-diff");
  });
});
