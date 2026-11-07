import { describe, expect, it } from "vite-plus/test";
import type * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as Schema from "effect/Schema";

import {
  RelayAgentActivitySnapshotEndpoint,
  RelayAgentActivitySnapshotResponse,
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

describe("RelayAgentActivitySnapshot", () => {
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
});
