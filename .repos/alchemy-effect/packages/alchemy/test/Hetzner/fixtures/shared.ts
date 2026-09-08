import * as Hetzner from "@/Hetzner";

export const VOLUME_PATH = "/data";
export const MARKER_FILE = `${VOLUME_PATH}/hello.txt`;
export const MARKER = "hello-from-worker";
export const API_PORT = 3000;

export const Box = Hetzner.Server("Box", {
  serverType: "cpx12",
  image: "ubuntu-24.04",
  location: "nbg1",
});

export const Data = Hetzner.Volume("Data", {
  size: 10,
  format: "ext4",
  location: "nbg1",
});
