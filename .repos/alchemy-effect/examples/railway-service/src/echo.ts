import * as Railway from "alchemy/Railway";
import { Site } from "./shared.ts";

/**
 * Image Service. No bundle, no registry. Railway pulls
 * `hashicorp/http-echo` and answers on port 5678. Same idea as a
 * Fly.Machine with a public image.
 */
export const Echo = Railway.Service("Echo", {
  project: Site,
  image: "hashicorp/http-echo",
  port: 5678,
  healthcheck: "/health",
});
