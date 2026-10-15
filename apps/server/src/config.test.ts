import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { assert, describe, it } from "@effect/vitest";

import * as ServerConfig from "./config.ts";

describe("otlpResource", () => {
  const resource = (resourceAttributes: Record<string, string>) =>
    ServerConfig.otlpResource(
      { mode: "web", otelEnvironment: { ...OtelEnvironment.none, resourceAttributes } },
      "box-1",
    );

  it("names the host, unless OTEL_RESOURCE_ATTRIBUTES already does", () => {
    assert.equal(resource({}).attributes["host.name"], "box-1");
    assert.equal(resource({ "host.name": "from-env" }).attributes["host.name"], "from-env");
    assert.equal(resource({ "host.name": "" }).attributes["host.name"], "box-1");
  });
});
