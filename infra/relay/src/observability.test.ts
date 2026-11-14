import { describe, expect, it } from "vite-plus/test";

import { relayRecentSpansQuery } from "./observability.ts";

describe("relayRecentSpansQuery", () => {
  it("reads user.id as one attribute key, where Axiom stores it", () => {
    const query = relayRecentSpansQuery("t3-code-relay-traces-dev");

    expect(query).toContain("column_ifexists('attributes.user.id', '')");
    expect(query).toContain("customAttributes['user.id']");
    expect(query).not.toContain("['user']['id']");
  });
});
