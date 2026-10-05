import { GcpEnvironment } from "@/GCP/Environment";
import { MinimumLogLevel } from "effect/References";
import * as Effect from "effect/Effect";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);
export const location = "us-central1";

export const TEST_RESOURCE_URI =
  "https://example.com/alchemy-test@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

export const TEST_ATTESTATION = {
  serializedPayload: btoa("alchemy-payload"),
  signatures: [
    {
      publicKeyId: "https://example.com/keys/alchemy",
      signature: btoa("alchemy-sig"),
    },
  ],
};
