import * as Fly from "@/Fly";
import * as Redacted from "effect/Redacted";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-fly-worker";
export const API_PORT = 3000;
export const SECRET_NAME = "FLY_FIXTURE_MARKER";

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});

export const Marker = Fly.Secret("Marker", {
  app: Site,
  name: SECRET_NAME,
  value: Redacted.make(MARKER),
});

export const PublicIp = Fly.IpAssignment("Shared", {
  app: Site,
  type: "shared_v4",
});
