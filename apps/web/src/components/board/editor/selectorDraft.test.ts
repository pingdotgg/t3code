import { describe, it, expect } from "vitest";

import {
  encodeSelector,
  decodeSelectorDraft,
  defaultJiraSelector,
} from "./selectorDraft";

describe("selectorDraft — Jira", () => {
  it("encodes a Jira draft with projectKey and jql", () => {
    const encoded = encodeSelector({
      provider: "jira",
      jira: { projectKey: "ENG", jql: "labels = backend" },
    });
    expect(encoded).toEqual({ projectKey: "ENG", jql: "labels = backend" });
  });

  it("omits jql key when jql is empty", () => {
    const encoded = encodeSelector({
      provider: "jira",
      jira: { projectKey: "ENG", jql: "" },
    });
    expect(encoded).toEqual({ projectKey: "ENG" });
    expect(encoded).not.toHaveProperty("jql");
  });

  it("omits jql key when jql is whitespace only", () => {
    const encoded = encodeSelector({
      provider: "jira",
      jira: { projectKey: "ENG", jql: "   " },
    });
    expect(encoded).toEqual({ projectKey: "ENG" });
    expect(encoded).not.toHaveProperty("jql");
  });

  it("trims projectKey on encode", () => {
    const encoded = encodeSelector({
      provider: "jira",
      jira: { projectKey: "  ENG  ", jql: "" },
    });
    expect(encoded).toEqual({ projectKey: "ENG" });
  });

  it("decodes a Jira source into a draft", () => {
    const draft = decodeSelectorDraft({
      provider: "jira",
      selector: { projectKey: "ENG" },
    });
    expect(draft).toEqual({
      provider: "jira",
      jira: { projectKey: "ENG", jql: "" },
    });
  });

  it("decodes a Jira source with jql into a draft", () => {
    const draft = decodeSelectorDraft({
      provider: "jira",
      selector: { projectKey: "ENG", jql: "labels = backend" },
    });
    expect(draft).toEqual({
      provider: "jira",
      jira: { projectKey: "ENG", jql: "labels = backend" },
    });
  });

  it("defaults missing fields to empty strings when decoding", () => {
    const draft = decodeSelectorDraft({
      provider: "jira",
      selector: null,
    });
    expect(draft).toEqual({
      provider: "jira",
      jira: { projectKey: "", jql: "" },
    });
  });

  it("defaultJiraSelector returns empty strings", () => {
    expect(defaultJiraSelector()).toEqual({ projectKey: "", jql: "" });
  });
});
