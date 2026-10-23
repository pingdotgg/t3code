import { describe, expect, it } from "@effect/vitest";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import { otlpResource } from "./config.ts";

describe("otlpResource", () => {
  it("gives every resource of one process the same service instance id", () => {
    const config = { mode: "web" as const, otelEnvironment: OtelEnvironment.none };

    const logs = otlpResource(config, "host-a");
    const traces = otlpResource(config, "host-a");

    expect(logs.attributes["service.instance.id"]).not.toBe("");
    expect(traces.attributes["service.instance.id"]).toBe(logs.attributes["service.instance.id"]);
  });

  it("uses the operator's service instance id instead of a generated one", () => {
    const resource = otlpResource(
      {
        mode: "web",
        otelEnvironment: {
          ...OtelEnvironment.none,
          resourceAttributes: { "service.instance.id": "pod-7" },
        },
      },
      "host-a",
    );

    expect(resource.attributes["service.instance.id"]).toBe("pod-7");
  });
});
