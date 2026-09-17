import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { WS_METHODS, WsRpcGroup, WsSubscribeServerConfigRpc } from "./rpc.ts";

describe("pull request action responses", () => {
  const rpc = WsRpcGroup.requests.get(WS_METHODS.pullRequestsRunAction)!;
  const codec = Schema.toCodecJson(Rpc.exitSchema(rpc));

  for (const state of ["pending", "completed", "failed"] as const) {
    it(`preserves ${state} operation outcomes through the RPC JSON codec`, () => {
      const outcome = {
        operation: { kind: "merge", id: "merge_acceptance" },
        state,
        detail: `Merge ${state}.`,
      } as const;
      const encoded = Schema.encodeSync(codec)(Exit.succeed(outcome));
      expect(encoded).toEqual({ _tag: "Success", value: outcome });
      expect(Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)))).toEqual(
        Exit.succeed(outcome),
      );
    });
  }

  it("retains void responses for actions without durable operations", () => {
    const encoded = Schema.encodeSync(codec)(Exit.succeed(undefined));
    expect(encoded).toEqual({ _tag: "Success", value: null });
    expect(Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(encoded)))).toEqual(
      Exit.succeed(undefined),
    );
  });
});

/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */
describe("subscribeServerConfig payload compatibility", () => {
  it("is accepted by a server whose schema predates the field", () => {
    const oldServerPayload = Schema.Struct({});
    const decoded = Schema.decodeUnknownExit(oldServerPayload)({ environmentThemes: true });
    expect(Exit.isSuccess(decoded)).toBe(true);
  });

  it("is carried by a server that declares it", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({
      environmentThemes: true,
    });
    expect(decoded).toEqual({ environmentThemes: true });
  });

  it("stays optional, so a client that never sends it still subscribes", () => {
    const decoded = Schema.decodeUnknownSync(WsSubscribeServerConfigRpc.payloadSchema)({});
    expect(decoded).toEqual({});
  });
});
