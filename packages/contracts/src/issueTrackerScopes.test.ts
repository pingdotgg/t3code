import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  IssueTrackerConnectionList,
  IssueTrackerScopePage,
  IssueTrackerScopesInput,
} from "./issue.ts";
import { WsRpcGroup, WS_METHODS } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthOrchestrationReadScope } from "./auth.ts";

const encode = Schema.encodeUnknownSync(IssueTrackerScopesInput);
const decode = Schema.decodeUnknownSync(IssueTrackerScopesInput);
const decodePage = Schema.decodeUnknownSync(IssueTrackerScopePage);
const decodeResult = Schema.decodeUnknownSync(IssueTrackerConnectionList);

describe("account scope continuation", () => {
  it("registers scope paging with a read grant and leaves catalog requests unchanged", () => {
    expect(WsRpcGroup.requests.has(WS_METHODS.issueTrackersScopes)).toBe(true);
    expect(clientRpcRequiredScopes(WS_METHODS.issueTrackersScopes, {})).toEqual([
      AuthOrchestrationReadScope,
    ]);
  });
  it("keeps the legacy catalog response unchanged", () => {
    expect(decodeResult({ trackers: [], bindings: {} })).toEqual({ trackers: [], bindings: {} });
  });

  it.each([undefined, "Account", "account"])("keeps selected account %s exact", (connectionId) => {
    const input = {
      tracker: "linear",
      cursor: "next",
      limit: 100,
      ...(connectionId === undefined ? {} : { connectionId }),
    };
    expect(decode(encode(input))).toEqual(input);
  });

  it("preserves an opaque continuation and distinguishes the final page", () => {
    expect(
      decodePage({ items: [{ key: "acme/ENG", name: "Engineering" }], nextCursor: "native-next" })
        .nextCursor,
    ).toBe("native-next");
    expect(decodePage({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it.each([0, 101])("rejects an out of bounds page limit %s", (limit) => {
    expect(() => encode({ tracker: "jira", cursor: "100", limit })).toThrow();
  });
  it("requires a nonempty continuation", () => {
    expect(() => decode({ tracker: "linear" })).toThrow();
    expect(() => decode({ tracker: "linear", cursor: " " })).toThrow();
  });
});
