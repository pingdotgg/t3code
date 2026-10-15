import { IssueTrackerConnectionError, IssueTrackerKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  connectFailureMessage,
  connectionFailureDetail,
  packCredential,
} from "./IssueTrackerSettings.logic";

const fields = [
  { key: "site", label: "Site", secret: false },
  { key: "email", label: "Email", secret: false },
  { key: "token", label: "Token", secret: true },
];

describe("packCredential", () => {
  it("sends a single raw credential as typed, trimmed", () => {
    expect(packCredential(undefined, { "": "  lin_api_x " })).toBe("lin_api_x");
    expect(packCredential(undefined, { "": "   " })).toBeNull();
  });

  it("packs every declared field into one JSON credential", () => {
    expect(
      JSON.parse(
        packCredential(fields, { site: " acme.atlassian.net ", email: "a@b.c", token: "t" }) ?? "",
      ),
    ).toEqual({ site: "acme.atlassian.net", email: "a@b.c", token: "t" });
  });

  it("refuses to pack while any field is blank", () => {
    expect(packCredential(fields, { site: "acme.atlassian.net", token: "t" })).toBeNull();
    expect(packCredential(fields, { site: "acme", email: " ", token: "t" })).toBeNull();
  });
});

describe("connectFailureMessage", () => {
  const error = (reason: "rejected" | "failed") =>
    new IssueTrackerConnectionError({
      tracker: IssueTrackerKind.make("jira"),
      reason,
      detail: "Jira could not be reached.",
    });

  it("says a refused credential was rejected", () => {
    expect(connectFailureMessage(error("rejected"))).toBe(
      "Credential rejected. Jira could not be reached.",
    );
  });

  it("reports any other failure without calling the credential rejected", () => {
    expect(connectFailureMessage(error("failed"))).toBe("Jira could not be reached.");
    expect(connectFailureMessage(new Error("Socket closed"))).toBe("Socket closed");
    expect(connectFailureMessage(undefined)).toBe("The request failed.");
  });

  it("reports a refused binding by its detail alone", () => {
    expect(connectionFailureDetail(error("rejected"))).toBe("Jira could not be reached.");
  });
});
