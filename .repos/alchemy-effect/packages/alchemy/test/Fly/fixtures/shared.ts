import * as Fly from "@/Fly";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-fly-service";
export const API_PORT = 3000;

export const Site = Fly.App("Site", {
  enableSubdomains: true,
});
