import { describe, expect, it } from "vite-plus/test";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivitySnapshotEndpoint,
} from "./relay.ts";

describe("RelayApi security", () => {
  it("decodes an older global snapshot without inventing filter support", () => {
    const decode = Schema.decodeUnknownSync(RelayAgentActivitySnapshotResponse);
    expect(decode({ aggregate: null })).toEqual({ aggregate: null });
    expect(decode({ aggregate: null, excludedEnvironmentIds: [] })).toEqual({
      aggregate: null,
      excludedEnvironmentIds: [],
    });
  });
  it("decodes absent, single and repeated exclusion query values", () => {
    const decode = Schema.decodeUnknownSync(
      RelayAgentActivitySnapshotEndpoint.query as HttpApiEndpoint.Query<
        typeof RelayAgentActivitySnapshotEndpoint
      >,
    );
    expect(decode({})).toEqual({});
    expect(decode({ excludedEnvironmentIds: "local" })).toEqual({
      excludedEnvironmentIds: ["local"],
    });
    expect(decode({ excludedEnvironmentIds: ["local", "other"] })).toEqual({
      excludedEnvironmentIds: ["local", "other"],
    });
  });
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
