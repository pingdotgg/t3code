import { assert, describe, it } from "@effect/vitest";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import * as ServerConfig from "./config.ts";

const deploymentEnvironment = (input: {
  readonly devUrl: URL | undefined;
  readonly resourceAttributes?: Readonly<Record<string, string>>;
}) => {
  const { attributes }: { readonly attributes: Readonly<Record<string, unknown>> } =
    ServerConfig.otlpResource(
      {
        mode: "web",
        devUrl: input.devUrl,
        otelEnvironment: {
          ...OtelEnvironment.none,
          resourceAttributes: input.resourceAttributes ?? {},
        },
      },
      "test-host",
    );
  return attributes["deployment.environment.name"];
};

describe("otlpResource", () => {
  it("reports a dev server as development", () => {
    assert.strictEqual(
      deploymentEnvironment({ devUrl: new URL("http://localhost:5733") }),
      "development",
    );
  });

  it("reports a server without a dev URL as production", () => {
    assert.strictEqual(deploymentEnvironment({ devUrl: undefined }), "production");
  });

  it("keeps the environment an operator set", () => {
    assert.strictEqual(
      deploymentEnvironment({
        devUrl: undefined,
        resourceAttributes: { "deployment.environment.name": "staging" },
      }),
      "staging",
    );
  });
});
