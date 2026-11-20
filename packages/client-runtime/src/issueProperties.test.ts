import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_PROPERTY_PIN_LIMIT,
  IssuePropertyPins,
  isEmptyIssuePropertyValue,
  issuePropertyObjectLabel,
  issuePropertyPinKey,
  pinnedIssueProperties,
  toggleIssuePropertyPin,
  visibleIssueProperties,
} from "./issueProperties.ts";

const issue = { tracker: "linear", host: "linear.app", scope: "ENG", key: "ENG-7" };
const isIssuePropertyPins = Schema.is(IssuePropertyPins);

describe("issue property pins", () => {
  it("keeps each issue's pins apart and forgets an issue with none left", () => {
    const key = issuePropertyPinKey(issue);
    expect(issuePropertyPinKey({ ...issue, host: "Linear.app", key: "eng-7" })).toBe(key);
    const pins = toggleIssuePropertyPin({}, key, "estimate");
    for (const other of [
      { ...issue, key: "ENG-8" },
      { ...issue, scope: "OPS" },
      { ...issue, tracker: "github" },
    ]) {
      expect(pins[issuePropertyPinKey(other)]).toBeUndefined();
    }

    const both = toggleIssuePropertyPin({ ...pins, other: ["state"] }, key, "priority");
    expect(both[key]).toEqual(["estimate", "priority"]);
    const cleared = toggleIssuePropertyPin(
      toggleIssuePropertyPin(both, key, "priority"),
      key,
      "estimate",
    );
    expect(cleared).toEqual({ other: ["state"] });

    const full = Array.from({ length: ISSUE_PROPERTY_PIN_LIMIT }, (_, index) => `field_${index}`);
    expect(toggleIssuePropertyPin({ [key]: full }, key, "one_more")[key]).toEqual(full);
    const long = toggleIssuePropertyPin(pins, key, `Custom.${"x".repeat(250)}`);
    expect(isIssuePropertyPins(long)).toBe(true);
  });

  it("shows pins in the order they were made, skipping a field the tracker stopped sending", () => {
    const properties = [
      { id: "priority", label: "Priority", value: "High" },
      { id: "estimate", label: "Estimate", value: 0 },
    ];
    expect(pinnedIssueProperties(properties, ["estimate", "gone", "priority"])).toEqual([
      properties[1],
      properties[0],
    ]);
  });
});

describe("issue property values", () => {
  it("treats false and zero as values and only blanks as unset", () => {
    for (const value of [null, "", [], [null, ""], {}]) {
      expect(isEmptyIssuePropertyValue(value)).toBe(true);
    }
    for (const value of [false, 0, "0", [false], { value: "Gold" }]) {
      expect(isEmptyIssuePropertyValue(value)).toBe(false);
    }
    expect(issuePropertyObjectLabel({ displayName: "Alex", accountId: "acc_1" })).toBe("Alex");
    expect(issuePropertyObjectLabel({ value: 0 })).toBe("0");
    expect(issuePropertyObjectLabel({ displayName: "", name: "Alex" })).toBe("Alex");
    expect(issuePropertyObjectLabel({ displayName: " ", accountId: "acc_1" })).toBeNull();
    expect(issuePropertyObjectLabel({ nested: { value: "Gold" } })).toBeNull();
  });

  it("hides empty fields until asked, and searches them by name or id", () => {
    const properties = [
      { id: "estimate", label: "Estimate", value: 0 },
      { id: "customfield_10020", label: "Sprint", value: null },
    ];
    expect(visibleIssueProperties(properties, "", false)).toEqual([properties[0]]);
    expect(visibleIssueProperties(properties, "", true)).toEqual(properties);
    expect(visibleIssueProperties(properties, " sprint ", false)).toEqual([properties[1]]);
    expect(visibleIssueProperties(properties, "10020", false)).toEqual([properties[1]]);
  });
});
