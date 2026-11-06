import { describe, expect, it } from "vite-plus/test";
import {
  isEmptyIssuePropertyValue,
  issuePropertyObjectLabel,
  orderIssueProperties,
} from "./issueProperties";

describe("isEmptyIssuePropertyValue", () => {
  it("treats unset Jira custom fields as empty", () => {
    expect(isEmptyIssuePropertyValue(null)).toBe(true);
    expect(isEmptyIssuePropertyValue("")).toBe(true);
    expect(isEmptyIssuePropertyValue([])).toBe(true);
    expect(isEmptyIssuePropertyValue([null, ""])).toBe(true);
    expect(isEmptyIssuePropertyValue({})).toBe(true);
  });

  it("keeps values a reader would want, including false and zero", () => {
    expect(isEmptyIssuePropertyValue(false)).toBe(false);
    expect(isEmptyIssuePropertyValue(0)).toBe(false);
    expect(isEmptyIssuePropertyValue(["bug"])).toBe(false);
    expect(isEmptyIssuePropertyValue({ name: "High" })).toBe(false);
  });
});

describe("issuePropertyObjectLabel", () => {
  it("names users, options and statuses by their display field", () => {
    expect(issuePropertyObjectLabel({ displayName: "Ada", accountId: "1" })).toBe("Ada");
    expect(issuePropertyObjectLabel({ self: "x", value: "Alone" })).toBe("Alone");
    expect(issuePropertyObjectLabel({ self: "x", id: "3" })).toBeNull();
  });
});

describe("orderIssueProperties", () => {
  const field = (id: string, label: string) => ({ id, label });

  it("leads Jira issues with the familiar fields, then sorts the rest by name", () => {
    const ordered = orderIssueProperties("jira", [
      field("customfield_2", "zeta"),
      field("updated", "Updated"),
      field("customfield_1", "Alpha"),
      field("status", "Status"),
      field("assignee", "Assignee"),
    ]);
    expect(ordered.map((property) => property.id)).toEqual([
      "status",
      "assignee",
      "updated",
      "customfield_1",
      "customfield_2",
    ]);
  });

  it("keeps a forge's curated order", () => {
    const properties = [field("user", "Author"), field("state", "State")];
    expect(orderIssueProperties("github", properties)).toBe(properties);
  });
});
