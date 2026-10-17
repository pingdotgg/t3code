import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { IssueListInput, issueListRequest } from "./issue.ts";
import { WsRpcGroup, WS_METHODS } from "./rpc.ts";
const codec = WsRpcGroup.requests.get(WS_METHODS.issuesList)!.payloadSchema;
const encode = Schema.encodeUnknownSync(codec);
const decode = Schema.decodeUnknownSync(codec);
const decodeLegacy = Schema.decodeUnknownSync(
  Schema.Struct({ state: Schema.Literals(["all", "open", "closed"]) }),
);

describe("selected issue list transport", () => {
  it("preserves flat input constructor metadata and aggregate bytes", () => {
    const input: IssueListInput = { state: "all", query: "bug" };
    expectTypeOf(issueListRequest(IssueListInput).make(input)).toExtend<IssueListInput>();
    expect(encode(input)).toEqual(input);
    expect(decode(encode(input))).toEqual(input);
  });
  it("preserves legacy host-only filtered aggregate bytes", () => {
    const input = { state: "all", host: "github.com" };
    expect(encode(input)).toEqual(input);
    expect(decode(encode(input))).toEqual(input);
    expect(decodeLegacy(encode(input))).toEqual({ state: "all" });
  });
  it.each([undefined, "Account", "account"])(
    "refuses old servers for filtered account %s",
    (connectionId) => {
      const input = {
        state: "all",
        projectId: "project",
        tracker: "github",
        host: "github.com",
        scope: "acme/other",
        ...(connectionId === undefined ? {} : { connectionId }),
      };
      const wire = encode(input);
      expect(wire).toMatchObject({
        host: "github.com",
        state: { value: "all", tracker: "github", scope: "acme/other" },
      });
      expect(decode(wire)).toEqual(input);
      expect(() => decodeLegacy(wire)).toThrow();
      expect(() => decode(input)).toThrow();
    },
  );
});
