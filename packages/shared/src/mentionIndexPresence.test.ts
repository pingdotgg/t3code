import { ComposerContextId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mentionIndexPresenceRequests } from "./mentionIndexPresence.ts";

describe("mentionIndexPresenceRequests", () => {
  it("collects exact fetch requests for pasted mention chips", () => {
    expect(
      mentionIndexPresenceRequests([
        {
          version: 1,
          kind: "jira",
          contextId: ComposerContextId.make("jira-1"),
          label: "PROJ-1",
          key: "PROJ-1",
          url: "https://acme.atlassian.net/browse/PROJ-1",
          summary: "PROJ-1",
        },
        {
          version: 1,
          kind: "figma",
          contextId: ComposerContextId.make("figma-1"),
          label: "Design",
          fileKey: "AbCdEfGhIjKlMnOp",
          url: "https://www.figma.com/design/AbCdEfGhIjKlMnOp",
          name: "Design",
        },
        {
          version: 1,
          kind: "issue",
          contextId: ComposerContextId.make("issue-1"),
          label: "#7",
          number: 7,
          title: "#7",
          url: "https://github.com/acme/app/issues/7",
          repository: "acme/app",
          state: "open",
        },
      ]),
    ).toEqual([
      { query: "PROJ-1", providers: ["jira"] },
      { query: "AbCdEfGhIjKlMnOp", providers: ["figma"] },
      { query: "https://github.com/acme/app/issues/7", providers: ["issue"] },
    ]);
  });
});
