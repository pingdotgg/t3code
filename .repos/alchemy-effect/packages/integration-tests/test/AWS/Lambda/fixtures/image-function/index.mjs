import { readFileSync } from "node:fs";

export const handler = async (event) => ({
  marker: readFileSync(new URL("./marker.txt", import.meta.url), "utf8").trim(),
  environment: process.env.IMAGE_FUNCTION_ENV,
  event,
});

export const alternate = async (event) => ({
  handler: "alternate",
  event,
});
