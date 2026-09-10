import * as Fly from "@/Fly";
import * as Redacted from "effect/Redacted";

export const API_PORT = 3000;
export const SECRET_NAME = "FLY_BINDINGS_MARKER";
export const MARKER = "hello-from-fly-bindings";
export const PLAINTEXT = "alchemy-kms-roundtrip";

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

export const Marker = Fly.Secret("Marker", {
  app: Site,
  name: SECRET_NAME,
  value: Redacted.make(MARKER),
});

export const BoxKey = Fly.SecretKey("Box", {
  app: Site,
  type: "nacl_secretbox",
});

export const SignKey = Fly.SecretKey("Signing", {
  app: Site,
  type: "nacl_sign",
});

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
