import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import {
  RelayAgentAwarenessPreferences,
  RelayApi,
  RelayBoardTicketPublishProofPayload,
  RelayBoardTicketState,
  WorkflowTicketAttentionKind,
} from "./relay.ts";

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});

describe("WorkflowTicketAttentionKind", () => {
  const decode = Schema.decodeUnknownEffect(WorkflowTicketAttentionKind);

  it.effect("decodes blocked", () =>
    Effect.gen(function* () {
      const kind = yield* decode("blocked");
      assert.equal(kind, "blocked");
    }),
  );

  it.effect("rejects an invalid kind", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(decode("bogus"));
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});

describe("RelayBoardTicketState", () => {
  const decode = Schema.decodeUnknownEffect(RelayBoardTicketState);

  it.effect("decodes a valid board ticket state with attentionKind blocked", () =>
    Effect.gen(function* () {
      const state = yield* decode({
        environmentId: "env-1",
        boardId: "b1",
        ticketId: "t1",
        attentionKind: "blocked",
        title: "Fix login",
        body: "Merge conflict in auth.ts",
        deepLink: "/tickets/env-1/b1/t1",
        transitionId: "42",
      });
      assert.equal(state.attentionKind, "blocked");
      assert.equal(state.ticketId, "t1");
    }),
  );
});

describe("RelayBoardTicketPublishProofPayload", () => {
  const decode = Schema.decodeUnknownEffect(RelayBoardTicketPublishProofPayload);

  it.effect("decodes a proof payload wrapping a board ticket state", () =>
    Effect.gen(function* () {
      const payload = yield* decode({
        iss: "relay.t3.dev",
        aud: "env-1",
        sub: "t1",
        jti: "nonce-1",
        iat: 1_700_000_000,
        exp: 1_700_003_600,
        environmentId: "env-1",
        boardId: "b1",
        ticketId: "t1",
        state: {
          environmentId: "env-1",
          boardId: "b1",
          ticketId: "t1",
          attentionKind: "blocked",
          title: "Fix login",
          body: "Merge conflict in auth.ts",
          deepLink: "/tickets/env-1/b1/t1",
          transitionId: "42",
        },
      });
      assert.equal(payload.ticketId, "t1");
      assert.equal(payload.state?.attentionKind, "blocked");
    }),
  );

  it.effect("decodes a proof payload with null state", () =>
    Effect.gen(function* () {
      const payload = yield* decode({
        iss: "relay.t3.dev",
        aud: "env-1",
        sub: "t1",
        jti: "nonce-2",
        iat: 1_700_000_000,
        exp: 1_700_003_600,
        environmentId: "env-1",
        boardId: "b1",
        ticketId: "t1",
        state: null,
      });
      assert.equal(payload.state, null);
    }),
  );
});

describe("RelayAgentAwarenessPreferences notifyOnBlocked", () => {
  const decode = Schema.decodeUnknownEffect(RelayAgentAwarenessPreferences);

  it.effect("decodes preferences WITHOUT notifyOnBlocked — field is undefined", () =>
    Effect.gen(function* () {
      const prefs = yield* decode({
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: false,
        notifyOnInput: false,
        notifyOnCompletion: true,
        notifyOnFailure: false,
      });
      assert.equal(prefs.notifyOnBlocked, undefined);
    }),
  );

  it.effect("decodes preferences WITH notifyOnBlocked:false", () =>
    Effect.gen(function* () {
      const prefs = yield* decode({
        liveActivitiesEnabled: true,
        notificationsEnabled: true,
        notifyOnApproval: false,
        notifyOnInput: false,
        notifyOnCompletion: true,
        notifyOnFailure: false,
        notifyOnBlocked: false,
      });
      assert.equal(prefs.notifyOnBlocked, false);
    }),
  );
});
