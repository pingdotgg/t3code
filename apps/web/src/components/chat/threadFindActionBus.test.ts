import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { findForMessageMatch } from "./threadFindActionBus";

describe("findForMessageMatch", () => {
  it("opens find on the longest word as the snippet writes it, at the matched message", () => {
    expect(
      findForMessageMatch(
        { snippet: "The cafeteria, then the Café", messageId: MessageId.make("message-1") },
        "cafe",
      ),
    ).toEqual({ query: "Café", start: { entryId: "message-1", occurrence: 0 } });
    expect(findForMessageMatch({ snippet: "fix the sidebar lag" }, "fix sidebar")).toEqual({
      query: "sidebar",
    });
    // The whole query, when the snippet holds it as typed.
    expect(findForMessageMatch({ snippet: "then Vp  run dev again" }, "vp run dev")).toEqual({
      query: "Vp  run dev",
    });
  });
});
