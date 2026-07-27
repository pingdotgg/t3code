import * as AWS from "@/AWS";
import { isNukeableHealthCheck } from "@/AWS/Route53/HealthCheck.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

test(
  "nuke inventory excludes AWS-service-owned health checks",
  Effect.sync(() => {
    expect(isNukeableHealthCheck({})).toBe(true);
    expect(
      isNukeableHealthCheck({
        LinkedService: {
          ServicePrincipal: "servicediscovery.amazonaws.com",
          Description: "Cloud Map managed health check",
        },
      }),
    ).toBe(false);
    expect(isNukeableHealthCheck({ LinkedService: {} })).toBe(false);
  }),
);
