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

export const TEST_PKIX_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWhkM5kl7ac/yZQwut5RYqCF6R9TA
zOV23AIF1+pYxbSAepfNDoU+tfNgHOFHzIjRNKB9Vv42auUzwwieQ6wK3Q==
-----END PUBLIC KEY-----`;

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

export const TEST_POD = {
  apiVersion: "v1",
  kind: "Pod",
  metadata: { name: "web", namespace: "default" },
  spec: { containers: [{ name: "nginx", image: "nginx" }] },
};
