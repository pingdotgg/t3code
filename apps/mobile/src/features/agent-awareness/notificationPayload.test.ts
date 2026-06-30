import { describe, expect, it } from "vite-plus/test";

import {
  encodeTicketDeepLink,
  extractAgentNotificationDeepLink,
  normalizeTicketDeepLink,
  routeAgentNotificationResponseOnce,
} from "./notificationPayload";

function responseWithData(data: Record<string, unknown>, identifier = "notification-1") {
  return {
    notification: {
      request: {
        identifier,
        content: {
          data,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// encodeTicketDeepLink
// ---------------------------------------------------------------------------
describe("encodeTicketDeepLink", () => {
  it("returns null when environmentId is empty", () => {
    expect(encodeTicketDeepLink({ environmentId: "", boardId: "b1", ticketId: "t1" })).toBeNull();
  });

  it("returns null when boardId is empty", () => {
    expect(encodeTicketDeepLink({ environmentId: "env", boardId: "", ticketId: "t1" })).toBeNull();
  });

  it("returns null when ticketId is empty", () => {
    expect(encodeTicketDeepLink({ environmentId: "env", boardId: "b1", ticketId: "" })).toBeNull();
  });

  it("encodes a basic ticket deep link", () => {
    expect(
      encodeTicketDeepLink({ environmentId: "env-1", boardId: "board-1", ticketId: "ticket-1" }),
    ).toBe("/tickets/env-1/board-1/ticket-1");
  });

  it("percent-encodes components with special characters", () => {
    expect(
      encodeTicketDeepLink({
        environmentId: "env 1",
        boardId: "board/2",
        ticketId: "ticket 3",
      }),
    ).toBe("/tickets/env%201/board%2F2/ticket%203");
  });
});

// ---------------------------------------------------------------------------
// normalizeTicketDeepLink
// ---------------------------------------------------------------------------
describe("normalizeTicketDeepLink", () => {
  it("accepts and round-trips a well-formed ticket path", () => {
    expect(normalizeTicketDeepLink("/tickets/env-1/b1/t1")).toBe("/tickets/env-1/b1/t1");
  });

  it("accepts a path with percent-encoded components", () => {
    expect(normalizeTicketDeepLink("/tickets/env%201/board%2F2/ticket%203")).toBe(
      "/tickets/env%201/board%2F2/ticket%203",
    );
  });

  it("rejects a path with too few segments (missing ticketId)", () => {
    expect(normalizeTicketDeepLink("/tickets/env-1/b1")).toBeNull();
  });

  it("rejects a path with too many segments", () => {
    expect(normalizeTicketDeepLink("/tickets/a/b/c/d")).toBeNull();
  });

  it("rejects a thread path", () => {
    expect(normalizeTicketDeepLink("/threads/env-1/t1")).toBeNull();
  });

  it("rejects a path with a query string", () => {
    expect(normalizeTicketDeepLink("/tickets/env/b/t?x=1")).toBeNull();
  });

  it("rejects a path with a hash fragment", () => {
    expect(normalizeTicketDeepLink("/tickets/env/b/t#section")).toBeNull();
  });

  it("rejects a path with leading double-slash", () => {
    expect(normalizeTicketDeepLink("//tickets/env/b/t")).toBeNull();
  });

  it("rejects a value with surrounding whitespace", () => {
    expect(normalizeTicketDeepLink(" /tickets/env/b/t")).toBeNull();
    expect(normalizeTicketDeepLink("/tickets/env/b/t ")).toBeNull();
  });

  it("rejects an empty middle segment (passes 5-segment check, fails encode)", () => {
    expect(normalizeTicketDeepLink("/tickets/env//t")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractAgentNotificationDeepLink — ticket paths
// ---------------------------------------------------------------------------
describe("extractAgentNotificationDeepLink — ticket deep links", () => {
  it("uses explicit ticket deep link from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/tickets/env/b/t",
        }),
      ),
    ).toBe("/tickets/env/b/t");
  });

  it("normalizes explicit ticket deep links with encoded components", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/tickets/env%201/board%2F2/ticket%203",
        }),
      ),
    ).toBe("/tickets/env%201/board%2F2/ticket%203");
  });

  it("falls back to identity fields when no deepLink", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          boardId: "board/2",
          ticketId: "ticket 3",
        }),
      ),
    ).toBe("/tickets/env%201/board%2F2/ticket%203");
  });

  it("uses ticket identity fallback when deepLink is not a recognized route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          boardId: "b",
          ticketId: "t",
        }),
      ),
    ).toBe("/tickets/env/b/t");
  });

  it("ignores malformed ticket deep link and falls back to ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/tickets/env/b",
          environmentId: "env",
          boardId: "b",
          ticketId: "t",
        }),
      ),
    ).toBe("/tickets/env/b/t");
  });
});

// ---------------------------------------------------------------------------
// REGRESSION: thread paths still work
// ---------------------------------------------------------------------------
describe("extractAgentNotificationDeepLink — thread deep links (regression)", () => {
  it("uses explicit thread deep link from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env/thread",
          environmentId: "ignored",
          threadId: "ignored",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("prefers the thread identity fallback over ticket when both id sets are present", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env",
          threadId: "thread",
          boardId: "b",
          ticketId: "t",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("normalizes explicit thread deep links from APNs payload data", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/threads/env%201/thread%2F2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to the thread route from environment and thread ids", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env 1",
          threadId: "thread/2",
        }),
      ),
    ).toBe("/threads/env%201/thread%2F2");
  });

  it("falls back to thread ids when explicit deep link is not a recognized route", () => {
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          deepLink: "/",
          environmentId: "env",
          threadId: "thread",
        }),
      ),
    ).toBe("/threads/env/thread");
  });

  it("ignores malformed or external links with no usable fallback", () => {
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "https://example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/settings" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "//example.com" })),
    ).toBeNull();
    expect(
      extractAgentNotificationDeepLink(responseWithData({ deepLink: "/threads/env/thread?x=1" })),
    ).toBeNull();
    expect(extractAgentNotificationDeepLink({})).toBeNull();
  });

  it("falls back to ticket identity when threadId is an empty string", () => {
    // An empty threadId must NOT short-circuit into the thread branch and return
    // null; the ticket-identity fallback must run instead.
    expect(
      extractAgentNotificationDeepLink(
        responseWithData({
          environmentId: "env",
          threadId: "",
          boardId: "board-1",
          ticketId: "ticket-1",
        }),
      ),
    ).toBe("/tickets/env/board-1/ticket-1");
  });
});

// ---------------------------------------------------------------------------
// routeAgentNotificationResponseOnce (regression)
// ---------------------------------------------------------------------------
describe("routeAgentNotificationResponseOnce", () => {
  it("does not navigate twice when the initial and listener responses refer to one notification", () => {
    const handledResponseIds = new Set<string>();
    const navigations: Array<string> = [];
    const response = responseWithData({
      environmentId: "env",
      threadId: "thread",
    });

    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });
    routeAgentNotificationResponseOnce({
      handledResponseIds,
      response,
      navigate: (deepLink) => navigations.push(deepLink),
    });

    expect(navigations).toEqual(["/threads/env/thread"]);
  });
});
