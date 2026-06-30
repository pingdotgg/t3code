import { assert, describe, it } from "@effect/vitest";

import { ticketBaseRef, ticketStepRef } from "./ticketRefs.ts";

describe("ticketRefs", () => {
  it("builds a stable base ref", () => {
    assert.equal(ticketBaseRef("t-1" as never), "refs/t3/tickets/dC0x/base");
  });

  it("builds pre/post step refs", () => {
    assert.equal(
      ticketStepRef("t-1" as never, "sr-1" as never, "pre"),
      "refs/t3/tickets/dC0x/step/c3ItMQ/pre",
    );
  });
});
