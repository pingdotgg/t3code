import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkItemMatchError,
  WorkItemMatchInput,
  WorkItemMatchResult,
  WorkItemTaskError,
  WorkItemTaskInput,
} from "./workItem.ts";

const match = {
  kind: "issue" as const,
  provider: "linear",
  repository: "ENG",
  number: 12,
  title: "Sessions expire too early",
  url: "https://linear.app/acme/issue/ENG-12",
  confidence: "high" as const,
  reason: "Reports the same session expiry bug.",
};

describe("work item matches", () => {
  it("keeps a source provider when equal references need disambiguation", () => {
    const decoded = Schema.decodeUnknownSync(WorkItemTaskInput)({
      projectId: "project-1",
      mode: "compound",
      items: [{ kind: "issue", provider: "linear", repository: "ENG", number: 12 }],
    });

    expect(decoded.items[0]?.provider).toBe("linear");
  });

  it("decodes a related-item request", () => {
    const decoded = Schema.decodeUnknownSync(WorkItemMatchInput)({
      projectId: "project-1",
      relationship: "related",
      source: { kind: "pull-request", repository: "acme/app", number: 34 },
    });

    expect(decoded.relationship).toBe("related");
  });

  it("rejects more than five visible suggestions", () => {
    expect(() =>
      Schema.decodeUnknownSync(WorkItemMatchResult)({ matches: Array(6).fill(match) }),
    ).toThrow();
  });

  it("keeps the failed operation and source on service errors", () => {
    const source = {
      kind: "issue" as const,
      provider: "linear",
      repository: "ENG",
      number: 12,
    };

    expect(
      new WorkItemTaskError({
        operation: "read-source",
        source,
        detail: "Could not read a selected work item.",
      }),
    ).toMatchObject({ operation: "read-source", source });
    expect(
      new WorkItemMatchError({
        operation: "list-candidates",
        source,
        detail: "Could not list candidate work items.",
      }),
    ).toMatchObject({ operation: "list-candidates", source });
  });
});
