import { describe, expect, it } from "vite-plus/test";
import {
  issueIdentityKey,
  pinnedIssueProperties,
  readIssuePins,
  toggleIssuePin,
  writeIssuePins,
} from "./issuePinPreferences";

const identity = { provider: "jira", host: "issues.example.invalid", id: "10042" };
const properties = [
  { id: "priority", label: "Priority", value: "High" },
  { id: "assignee", label: "Assignee", value: "Casey" },
] as const;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

describe("issue pin preferences", () => {
  it("restores pinned summary fields and persists unpinning every field", () => {
    const storage = memoryStorage();
    writeIssuePins(identity, toggleIssuePin([], "priority"), storage);
    expect(pinnedIssueProperties(properties, readIssuePins(identity, storage))).toEqual([
      properties[0],
    ]);
    const refreshedProperties = [{ ...properties[0], value: "Low" }, properties[1]];
    expect(
      pinnedIssueProperties(refreshedProperties, readIssuePins(identity, storage))[0]?.value,
    ).toBe("Low");
    writeIssuePins(identity, toggleIssuePin(readIssuePins(identity, storage), "priority"), storage);
    expect(readIssuePins(identity, storage)).toEqual([]);
  });

  it("isolates immutable issue identities and hosts while tolerating host casing", () => {
    const storage = memoryStorage();
    writeIssuePins(identity, ["priority"], storage);
    expect(readIssuePins({ ...identity, host: "other.example.invalid" }, storage)).toEqual([]);
    expect(readIssuePins({ ...identity, id: "10043" }, storage)).toEqual([]);
    expect(readIssuePins({ ...identity, host: "ISSUES.EXAMPLE.INVALID" }, storage)).toEqual([
      "priority",
    ]);
    expect(issueIdentityKey(identity)).toBe(issueIdentityKey({ ...identity, provider: "JIRA" }));
  });

  it("stores field IDs without property labels or values", () => {
    const storage = memoryStorage();
    writeIssuePins(identity, ["priority", "assignee", "priority"], storage);
    expect([...storage.values.values()]).toEqual(['["priority","assignee"]']);
  });

  it("ignores absent fields without destroying their saved preferences", () => {
    const storage = memoryStorage();
    writeIssuePins(identity, ["assignee", "removed", "priority"], storage);
    expect(pinnedIssueProperties(properties, readIssuePins(identity, storage))).toEqual([
      properties[1],
      properties[0],
    ]);
    expect(readIssuePins(identity, storage)).toEqual(["assignee", "removed", "priority"]);
  });

  it("recovers from malformed and unavailable storage", () => {
    expect(readIssuePins(identity, { getItem: () => "{", setItem: () => {} })).toEqual([]);
    expect(
      readIssuePins(identity, {
        getItem: () => '["priority",null,"",3,"priority"]',
        setItem: () => {},
      }),
    ).toEqual(["priority"]);
    const unavailable = {
      getItem: () => {
        throw new Error("Unavailable");
      },
      setItem: () => {
        throw new Error("Unavailable");
      },
    };
    expect(readIssuePins(identity, unavailable)).toEqual([]);
    expect(() => writeIssuePins(identity, ["priority"], unavailable)).not.toThrow();
  });
});
