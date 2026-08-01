import { describe, expect, it } from "vite-plus/test";

import {
  releaseTerminalOpen,
  reservedTerminalOpenIds,
  reserveTerminalOpen,
} from "./terminalOpenReservations";

describe("terminalOpenReservations", () => {
  it("reserves an id only while its open request is in flight", () => {
    // Open terminal-2, close its tab mid-request, allocate again: the id must
    // stay reserved until the request settles, then become reusable.
    reserveTerminalOpen("thread-a", "terminal-2");
    expect(reservedTerminalOpenIds("thread-a")).toEqual(["terminal-2"]);

    releaseTerminalOpen("thread-a", "terminal-2");
    expect(reservedTerminalOpenIds("thread-a")).toEqual([]);
  });

  it("scopes reservations per thread and tolerates unknown releases", () => {
    reserveTerminalOpen("thread-a", "terminal-2");
    reserveTerminalOpen("thread-b", "terminal-2");
    releaseTerminalOpen("thread-a", "terminal-2");
    releaseTerminalOpen("thread-a", "never-reserved");
    releaseTerminalOpen("thread-c", "terminal-2");

    expect(reservedTerminalOpenIds("thread-a")).toEqual([]);
    expect(reservedTerminalOpenIds("thread-b")).toEqual(["terminal-2"]);
    releaseTerminalOpen("thread-b", "terminal-2");
  });
});
