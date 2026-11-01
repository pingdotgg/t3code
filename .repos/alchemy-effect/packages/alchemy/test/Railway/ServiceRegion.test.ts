import {
  activeReplicaRegions,
  observedRegion,
  regionPlacementPatch,
  serviceRegionPlacement,
} from "@/Railway/ServiceRegion.ts";
import { describe, expect, it } from "alchemy-test";

describe("Railway service region placement", () => {
  it("reads deploy.multiRegionConfig and ignores the legacy region field", () => {
    const placement = serviceRegionPlacement(
      {
        services: {
          api: {
            deploy: {
              region: "us-west2",
              multiRegionConfig: {
                "asia-southeast1-eqsg3a": { numReplicas: 1 },
                "europe-west4-drams3a": null,
              },
            },
          },
        },
      },
      "api",
    );

    expect(activeReplicaRegions(placement)).toEqual([
      { region: "asia-southeast1-eqsg3a", replicas: 1 },
    ]);
    expect(observedRegion(placement, null)).toEqual("asia-southeast1-eqsg3a");
  });

  it("moves the workspace default onto the requested region", () => {
    const placement = {
      "asia-southeast1-eqsg3a": { numReplicas: 1 },
    };

    expect(regionPlacementPatch("europe-west4-drams3a", placement)).toEqual({
      "europe-west4-drams3a": { numReplicas: 1 },
      "asia-southeast1-eqsg3a": null,
    });
  });

  it("keeps an existing replica count on the target region", () => {
    expect(
      regionPlacementPatch("us-west2", {
        "us-west2": { numReplicas: 3 },
        "us-east4-eqdc4a": { numReplicas: 1 },
      }),
    ).toEqual({
      "us-west2": { numReplicas: 3 },
      "us-east4-eqdc4a": null,
    });
  });

  it("leaves a service that is already only in the requested region", () => {
    expect(
      regionPlacementPatch("us-west2", {
        "us-west2": { numReplicas: 2 },
        "europe-west4-drams3a": null,
      }),
    ).toBeUndefined();
  });

  it("uses the legacy replica count when placement is empty", () => {
    expect(regionPlacementPatch("us-west2", {}, 4)).toEqual({
      "us-west2": { numReplicas: 4 },
    });
  });
});
