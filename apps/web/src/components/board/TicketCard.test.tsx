import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { TicketCard } from "./TicketCard";

const renderTicketCard = (status: string) =>
  renderToStaticMarkup(
    <DndContext>
      <SortableContext items={[`ticket-${status}`]}>
        <TicketCard
          ticket={{
            ticketId: `ticket-${status}`,
            title: `Ticket ${status}`,
            status,
          }}
          onOpen={() => {}}
        />
      </SortableContext>
    </DndContext>,
  );

describe("TicketCard", () => {
  it("renders a queued badge for queued tickets", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-queued"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-queued",
              title: "Wait for capacity",
              description: "Hold until the release lane has room.",
              status: "queued",
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).toContain("Wait for capacity");
    expect(markup).toContain("Hold until the release lane has room.");
    expect(markup).toContain("queued");
  });

  it("renders a waiting-on-dependencies badge when dependencies are unresolved", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-dep"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-dep",
              title: "Blocked work",
              status: "queued",
              unresolvedDependencyCount: 2,
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).toContain("waiting on");
    expect(markup).toContain("2");
    expect(markup).toContain("dependencies");
  });

  it("states status once, in words, with the right tone", () => {
    const cases = [
      { status: "running", tone: "success", label: "running" },
      { status: "blocked", tone: "warning", label: "blocked" },
      { status: "waiting_on_user", tone: "warning", label: "waiting on you" },
      { status: "failed", tone: "destructive", label: "failed" },
      { status: "queued", tone: "muted", label: "queued" },
      { status: "done", tone: "settled", label: "done" },
    ];

    for (const { status, tone, label } of cases) {
      const markup = renderTicketCard(status);

      expect(markup).toContain(`data-status="${status}"`);
      expect(markup).toContain(`data-status-tone="${tone}"`);
      expect(markup).toContain('data-testid="ticket-status"');
      expect(markup).toContain(label);
      // Status is a single text element: no accent border, no status dot pile.
      expect(markup).not.toContain("border-l-4");
      expect(markup).not.toContain("ticket-status-accent");
    }
  });

  it("renders no status chrome at all for idle tickets", () => {
    const markup = renderTicketCard("idle");

    expect(markup).toContain('data-status="idle"');
    expect(markup).not.toContain('data-testid="ticket-status"');
    expect(markup).not.toContain("border-l-4");
  });

  it("shows a live indicator only while running", () => {
    expect(renderTicketCard("running")).toContain("animate-ping");
    for (const status of ["idle", "queued", "blocked", "waiting_on_user", "failed", "done"]) {
      expect(renderTicketCard(status)).not.toContain("animate-ping");
    }
  });

  it("renders the PR chip with the number when pr is present", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-pr"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-pr",
              title: "Add OAuth",
              status: "done",
              pr: { number: 42, url: "https://github.com/org/repo/pull/42", state: "open" },
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).toContain('data-testid="ticket-pr-chip"');
    expect(markup).toContain("#42");
  });

  it("shows a success-colored dot when ciState=success", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-ci"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-ci",
              title: "CI green",
              status: "running",
              pr: {
                number: 7,
                url: "https://github.com/org/repo/pull/7",
                state: "open",
                ciState: "success",
              },
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).toContain("bg-success");
  });

  it("shows a destructive dot when ciState=failure", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-ci-fail"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-ci-fail",
              title: "CI red",
              status: "blocked",
              pr: {
                number: 8,
                url: "https://github.com/org/repo/pull/8",
                state: "open",
                ciState: "failure",
              },
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).toContain("bg-destructive");
  });

  it("renders no PR chip when pr is absent", () => {
    const markup = renderToStaticMarkup(
      <DndContext>
        <SortableContext items={["ticket-no-pr"]}>
          <TicketCard
            ticket={{
              ticketId: "ticket-no-pr",
              title: "No PR yet",
              status: "idle",
            }}
            onOpen={() => {}}
          />
        </SortableContext>
      </DndContext>,
    );

    expect(markup).not.toContain('data-testid="ticket-pr-chip"');
  });
});
