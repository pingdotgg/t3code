import { describe, expect, it } from "vitest";
import { buildConnectionInput, isConnectionFormValid, type ConnectionFormState } from "./jiraConnectionForm.ts";

const base: ConnectionFormState = {
  provider: "github",
  displayName: "X",
  token: "t",
  jiraDeployment: "cloud",
  baseUrl: "",
  email: "",
};

describe("jiraConnectionForm", () => {
  it("github needs only displayName + token", () => {
    expect(isConnectionFormValid(base)).toBe(true);
    const input = buildConnectionInput(base);
    expect(input).toEqual({ provider: "github", displayName: "X", token: "t" });
  });

  it("jira cloud requires base url + email and maps to basic auth", () => {
    const cloud: ConnectionFormState = {
      ...base,
      provider: "jira",
      jiraDeployment: "cloud",
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.test",
    };
    expect(isConnectionFormValid(cloud)).toBe(true);
    expect(buildConnectionInput(cloud)).toEqual({
      provider: "jira",
      displayName: "X",
      token: "t",
      authMode: "basic",
      baseUrl: "https://acme.atlassian.net",
      email: "me@acme.test",
    });
  });

  it("jira cloud is invalid without an email", () => {
    expect(
      isConnectionFormValid({
        ...base,
        provider: "jira",
        jiraDeployment: "cloud",
        baseUrl: "https://acme.atlassian.net",
        email: "",
      }),
    ).toBe(false);
  });

  it("jira server requires base url, no email, maps to bearer auth", () => {
    const server: ConnectionFormState = {
      ...base,
      provider: "jira",
      jiraDeployment: "server",
      baseUrl: "https://jira.corp",
      email: "",
    };
    expect(isConnectionFormValid(server)).toBe(true);
    expect(buildConnectionInput(server)).toEqual({
      provider: "jira",
      displayName: "X",
      token: "t",
      authMode: "bearer",
      baseUrl: "https://jira.corp",
    });
  });

  it("jira server is invalid with a non-http base url", () => {
    expect(
      isConnectionFormValid({
        ...base,
        provider: "jira",
        jiraDeployment: "server",
        baseUrl: "jira.corp", // missing protocol
        email: "",
      }),
    ).toBe(false);
  });
});
