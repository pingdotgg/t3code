import { describe, expect, it } from "vite-plus/test";
import type * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";
import * as Schema from "effect/Schema";

import {
  RelayApi,
  RelayAgentActivitySnapshotResponse,
  RelayAgentActivitySnapshotEndpoint,
  RelayDeviceRegistrationRequest,
} from "./relay.ts";

const decodeDevice = Schema.decodeUnknownExit(RelayDeviceRegistrationRequest);
const device = {
  deviceId: "device",
  label: "Phone",
  pushToken: "token",
  preferences: {
    notificationsEnabled: true,
    liveActivitiesEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  },
};

describe("mobile device platforms", () => {
  it.each([
    [23, "Failure"],
    [24, "Success"],
    [37, "Success"],
  ])("enforces the Android minimum without an upper bound (API %i)", (androidApiLevel, result) => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel })._tag).toBe(result);
  });

  it("accepts Android tokens without Apple routing and preserves older iOS registrations", () => {
    expect(decodeDevice({ ...device, platform: "android", androidApiLevel: 36 })._tag).toBe(
      "Success",
    );
    expect(decodeDevice({ ...device, platform: "ios", iosMajorVersion: 18 })._tag).toBe("Success");
  });
  it("rejects missing platform versions and Apple activity tokens on Android", () => {
    expect(decodeDevice({ ...device, platform: "ios" })._tag).toBe("Failure");
    expect(decodeDevice({ ...device, platform: "android" })._tag).toBe("Failure");
    expect(
      decodeDevice({
        ...device,
        platform: "android",
        androidApiLevel: 36,
        pushToStartToken: "apple-token",
      })._tag,
    ).toBe("Failure");
  });
});

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
