import { describe, expect, it } from "vite-plus/test";

import {
  isTerminalOpenReservationActive,
  releaseTerminalOpen,
  reserveTerminalOpen,
  reservedTerminalOpenIds,
} from "./terminalOpenReservations";

describe("terminalOpenReservations", () => {
  it("releases ids after an open request settles", () => {
    const reservation = reserveTerminalOpen("thread-a", "term-2");
    expect(reservedTerminalOpenIds("thread-a")).toEqual(["term-2"]);

    releaseTerminalOpen("thread-a", "term-2", reservation);
    expect(reservedTerminalOpenIds("thread-a")).toEqual([]);
  });

  it("does not let a stale failure release a newer reservation", () => {
    const stale = reserveTerminalOpen("thread-a", "term-2");
    const current = reserveTerminalOpen("thread-a", "term-2");

    releaseTerminalOpen("thread-a", "term-2", stale);
    expect(isTerminalOpenReservationActive("thread-a", "term-2", current)).toBe(true);
    expect(reservedTerminalOpenIds("thread-a")).toEqual(["term-2"]);

    releaseTerminalOpen("thread-a", "term-2", current);
    expect(reservedTerminalOpenIds("thread-a")).toEqual([]);
  });

  it("scopes reservations per thread and tolerates unknown releases", () => {
    const reservation = reserveTerminalOpen("thread-b", "term-2");
    releaseTerminalOpen("thread-a", "term-2");
    releaseTerminalOpen("thread-b", "never-reserved");

    expect(reservedTerminalOpenIds("thread-a")).toEqual([]);
    expect(reservedTerminalOpenIds("thread-b")).toEqual(["term-2"]);
    releaseTerminalOpen("thread-b", "term-2", reservation);
  });
});
