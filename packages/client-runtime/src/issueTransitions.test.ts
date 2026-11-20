import { describe, expect, it } from "@effect/vitest";
import type { IssueTransition } from "@t3tools/contracts";

import { issueTransitionSubmission } from "./issueTransitions.ts";

const transition: IssueTransition = {
  id: "31",
  name: "Resolve issue",
  to: { name: "Done", category: "closed" },
  fields: [
    {
      id: "resolution",
      label: "Resolution",
      required: true,
      type: "select",
      options: [
        { value: "1", label: "Fixed" },
        { value: "2", label: "Won't do" },
      ],
    },
    { id: "estimate", label: "Estimate", required: false, type: "number", options: [] },
    {
      id: "labels",
      label: "Labels",
      required: false,
      type: "multiselect",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
};

describe("issueTransitionSubmission", () => {
  it("requires an explicit resolution, retains zero, and rejects stale choices", () => {
    expect(issueTransitionSubmission(transition, {}).errors.resolution).toBeTruthy();
    expect(
      issueTransitionSubmission(transition, { resolution: "1", estimate: "0", labels: ["b"] }),
    ).toEqual({
      fields: { resolution: "1", estimate: 0, labels: ["b"] },
      errors: {},
      blocked: false,
    });
    const invalid = issueTransitionSubmission(transition, {
      resolution: "old",
      estimate: "NaN",
      labels: ["missing"],
    });
    expect(Object.keys(invalid.errors)).toEqual(["resolution", "estimate", "labels"]);
  });

  it("reads a browser datetime-local value, which has no zone, as local time", () => {
    const scheduled: IssueTransition = {
      ...transition,
      fields: [{ id: "at", label: "Scheduled", required: true, type: "datetime", options: [] }],
    };
    expect(issueTransitionSubmission(scheduled, { at: "2026-11-17T13:00" }).fields).toEqual({
      // @effect-diagnostics-next-line globalDate:off - The expected instant is 13:00 in the runner's zone.
      at: new Date(2026, 10, 17, 13, 0).toISOString(),
    });
  });

  it("blocks unsupported required fields and omits empty optional inputs", () => {
    expect(
      issueTransitionSubmission(
        {
          ...transition,
          fields: [
            ...transition.fields,
            { id: "approval", label: "Approval", required: true, type: "unsupported", options: [] },
          ],
        },
        { resolution: "1" },
      ).blocked,
    ).toBe(true);
    expect(
      issueTransitionSubmission(transition, { resolution: "2", estimate: " ", labels: [] }).fields,
    ).toEqual({ resolution: "2" });
  });
});
