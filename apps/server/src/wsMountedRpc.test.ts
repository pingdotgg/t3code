import { describe, expect, it } from "vite-plus/test";
import { ForkWsRpcGroup, OfficialWsRpcGroup, WS_METHODS } from "@t3tools/contracts";

import authorizedUpstreamWsRpcTags from "./authorizedUpstreamWsRpcTags.json" with { type: "json" };
import { mountedOtherWsRpcTags, mountedServerWsRpcTags, mountedSplitWsRpcTags } from "./ws.ts";

const restoredFeatureRpcs = [
  WS_METHODS.annotationsSubscribe,
  WS_METHODS.annotationsCreate,
  WS_METHODS.annotationsRemove,
] as const;

const connMainAlreadyMountedExtras = [
  WS_METHODS.desktopTabRegister,
  WS_METHODS.desktopTabRequests,
  WS_METHODS.desktopTabRespond,
] as const;

describe("mounted server WS RPCs", () => {
  it("mounts official RPCs and only the authorized annotation fork RPCs", () => {
    const mounted = new Set(mountedServerWsRpcTags);
    const official = new Set(OfficialWsRpcGroup.requests.keys());
    const splitAndOther = new Set([...mountedSplitWsRpcTags, ...mountedOtherWsRpcTags]);

    expect(mounted).toEqual(new Set([...official, ...restoredFeatureRpcs]));
    expect(splitAndOther).toEqual(official);
    expect(mountedSplitWsRpcTags.length + mountedOtherWsRpcTags.length).toBe(official.size);

    for (const tag of ForkWsRpcGroup.requests.keys()) {
      expect(mounted.has(tag)).toBe(restoredFeatureRpcs.some((restored) => restored === tag));
    }
  });

  it("mounts only authorized upstream, desktop relay and restored feature RPCs", () => {
    const authorized = new Set([
      ...authorizedUpstreamWsRpcTags,
      ...connMainAlreadyMountedExtras,
      WS_METHODS.providerAuthRemoveMethod,
      WS_METHODS.serverGetSettings,
      ...restoredFeatureRpcs,
    ]);
    expect(new Set(mountedServerWsRpcTags)).toEqual(authorized);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRegister);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRequests);
    expect(authorizedUpstreamWsRpcTags).not.toContain(WS_METHODS.desktopTabRespond);
  });
});
