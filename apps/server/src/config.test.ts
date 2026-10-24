import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import { assert, describe, it } from "@effect/vitest";

import packageJson from "../package.json" with { type: "json" };
import * as ServerConfig from "./config.ts";

describe("otlpResource", () => {
  const resource = (
    resourceAttributes: Record<string, string>,
    overrides: Partial<Pick<ServerConfig.ServerConfig["Service"], "mode" | "devUrl">> = {},
  ) =>
    ServerConfig.otlpResource(
      {
        mode: "web",
        devUrl: undefined,
        otelEnvironment: { ...OtelEnvironment.none, resourceAttributes },
        ...overrides,
      },
      "box-1",
    );

  it("reports the server's own version, release channel and environment", () => {
    const attributes: Readonly<Record<string, unknown>> = resource({}).attributes;
    assert.equal(resource({}).serviceVersion, packageJson.version);
    assert.equal(attributes["t3code.release.channel"], "stable");
    assert.equal(attributes["deployment.environment.name"], "production");

    const dev: Readonly<Record<string, unknown>> = resource(
      {},
      { devUrl: new URL("http://localhost:5733") },
    ).attributes;
    assert.equal(dev["t3code.release.channel"], "dev");
    assert.equal(dev["deployment.environment.name"], "development");

    const operator: Readonly<Record<string, unknown>> = resource({
      "t3code.release.channel": "nightly",
      "deployment.environment.name": "staging",
    }).attributes;
    assert.equal(operator["t3code.release.channel"], "nightly");
    assert.equal(operator["deployment.environment.name"], "staging");
  });
});
