import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import {
  LinearConnectInput,
  LinearConnection,
  LinearDisconnectInput,
  LinearSetProjectBindingInput,
} from "./issueTracking.ts";

describe("Linear connection contracts", () => {
  it("decodes more than one saved account without exposing tokens", () => {
    const decoded = Schema.decodeUnknownSync(LinearConnection)({
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: "ada@example.com",
      teams: [],
      accounts: [
        {
          credentialId: "user-1",
          status: "authenticated",
          accountName: "Ada",
          accountEmail: "ada@example.com",
          teams: [{ id: "team-1", key: "ENG", name: "Engineering" }],
        },
        {
          credentialId: "user-2",
          status: "authenticated",
          accountName: "Grace",
          accountEmail: "grace@example.com",
          teams: [{ id: "team-2", key: "OPS", name: "Operations" }],
        },
      ],
    });

    expect(decoded.accounts.map(({ credentialId }) => credentialId)).toEqual(["user-1", "user-2"]);
    expect(JSON.stringify(decoded)).not.toContain("lin_api_");
  });

  it("keeps environment-account teams beside saved accounts", () => {
    const decoded = Schema.decodeUnknownSync(LinearConnection)({
      status: "authenticated",
      hasStoredToken: true,
      accountName: "Ada",
      accountEmail: null,
      teams: [],
      accounts: [],
      environmentAccount: {
        status: "authenticated",
        accountName: "Environment account",
        accountEmail: null,
        teams: [{ id: "team-env", key: "ENV", name: "Environment" }],
      },
    });

    expect(decoded.environmentAccount?.teams[0]?.key).toBe("ENV");
  });

  it("accepts old disconnect calls without a payload", () => {
    expect(Schema.decodeUnknownSync(LinearDisconnectInput)(undefined)).toBeUndefined();
  });

  it("accepts the credential being disconnected", () => {
    expect(Schema.decodeUnknownSync(LinearDisconnectInput)({ credentialId: " user-1 " })).toEqual({
      credentialId: "user-1",
    });
  });

  it("treats a missing connect mode as legacy replace and accepts explicit add mode", () => {
    expect(Schema.decodeUnknownSync(LinearConnectInput)({ token: " lin_api_old " })).toEqual({
      token: "lin_api_old",
    });
    expect(
      Schema.decodeUnknownSync(LinearConnectInput)({ token: "lin_api_new", mode: "add" }),
    ).toEqual({ token: "lin_api_new", mode: "add" });
  });

  it("decodes one saved-credential project binding command", () => {
    expect(
      Schema.decodeUnknownSync(LinearSetProjectBindingInput)({
        projectId: " project_1 ",
        binding: { credentialId: " user-1 ", teamKey: " ENG " },
      }),
    ).toEqual({
      projectId: "project_1",
      binding: { credentialId: "user-1", teamKey: "ENG" },
    });
    expect(
      Schema.decodeUnknownSync(LinearSetProjectBindingInput)({
        projectId: "project_1",
        binding: { teamKey: " ENV " },
      }),
    ).toEqual({ projectId: "project_1", binding: { teamKey: "ENV" } });
    expect(
      Schema.decodeUnknownSync(LinearSetProjectBindingInput)({
        projectId: "project_1",
        binding: null,
      }),
    ).toEqual({ projectId: "project_1", binding: null });
  });

  it("routes the project binding command through the WebSocket RPC group", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.linearSetProjectBinding)).toBe(true);
  });
});
