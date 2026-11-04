import { Config } from "@remotion/cli/config";

// Captures (scene.json, terminal clips, page screenshots) are the public dir.
Config.setPublicDir("./out/capture");
Config.setVideoImageFormat("jpeg");
