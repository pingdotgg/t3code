import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import { AuthSettingsWriteScope } from "./auth.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";

describe("clientRpcRequiredScopes", () => {
  it("accepts decoded duration settings", () => {
    expect(
      clientRpcRequiredScopes(WS_METHODS.serverUpdateSettings, {
        patch: { automaticGitFetchInterval: Duration.seconds(30) },
      }),
    ).toEqual([AuthSettingsWriteScope]);
  });
});
