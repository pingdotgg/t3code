import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import {
  IssueTrackerConnectInput,
  IssueTrackerConnection,
  IssueTrackerDisconnectInput,
  IssueTrackerBindInput,
} from "./issueTracking.ts";

const decodeConnection = Schema.decodeUnknownSync(IssueTrackerConnection);
const decodeDisconnect = Schema.decodeUnknownSync(IssueTrackerDisconnectInput);
const decodeConnect = Schema.decodeUnknownSync(IssueTrackerConnectInput);
const decodeBind = Schema.decodeUnknownSync(IssueTrackerBindInput);

describe("Issue tracker connection contracts", () => {
  it("decodes more than one saved account without exposing tokens", () => {
    const decoded = decodeConnection({
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      projects: [],
      accounts: [
        {
          credentialId: "user-1",
          status: "authenticated",
          accountName: "Ada",
          accountEmail: "ada@example.com",
          projects: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
        {
          credentialId: "user-2",
          status: "authenticated",
          accountName: "Grace",
          accountEmail: "grace@example.com",
          projects: [{ id: "team-2", key: "OPS", name: "Operations" }],
        },
      ],
    });

    expect(decoded.accounts.map(({ credentialId }) => credentialId)).toEqual(["user-1", "user-2"]);
    expect(JSON.stringify(decoded)).not.toContain("lin_api_");
  });

  it("keeps environment-account teams beside saved accounts", () => {
    const decoded = decodeConnection({
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: null,
      projects: [],
      accounts: [],
      environmentAccount: {
        status: "authenticated",
        accountName: "Environment account",
        accountEmail: null,
        projects: [{ id: "team-env", key: "ENV", name: "Environment" }],
      },
    });

    expect(decoded.environmentAccount?.projects[0]?.key).toBe("ENV");
  });

  it("requires a provider and an explicit credential for disconnect", () => {
    expect(() => decodeDisconnect(undefined)).toThrow();
    expect(() => decodeDisconnect({ credentialId: "user-1" })).toThrow();
  });

  it("accepts the credential being disconnected", () => {
    expect(decodeDisconnect({ provider: "linear", credentialId: " user-1 " })).toEqual({
      provider: "linear",
      credentialId: "user-1",
    });
  });

  it("trims a new account token", () => {
    expect(decodeConnect({ provider: "linear", token: " lin_api_new " })).toEqual({
      provider: "linear",
      token: "lin_api_new",
    });
  });

  it("decodes one saved-credential project binding command", () => {
    expect(
      decodeBind({
        provider: "linear",
        projectId: " project_1 ",
        binding: { credentialId: " user-1 ", repository: " ENG " },
      }),
    ).toEqual({
      provider: "linear",
      projectId: "project_1",
      binding: { credentialId: "user-1", repository: "ENG" },
    });
    expect(
      decodeBind({
        provider: "linear",
        projectId: "project_1",
        binding: { repository: " ENV " },
      }),
    ).toEqual({ provider: "linear", projectId: "project_1", binding: { repository: "ENV" } });
    expect(
      decodeBind({
        provider: "linear",
        projectId: "project_1",
        binding: null,
      }),
    ).toEqual({ provider: "linear", projectId: "project_1", binding: null });
  });

  it("routes the project binding command through the WebSocket RPC group", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.issueTrackersBind)).toBe(true);
  });
});
