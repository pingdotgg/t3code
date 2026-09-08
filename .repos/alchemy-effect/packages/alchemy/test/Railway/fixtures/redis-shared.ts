import { Redis } from "@/Railway/Redis.ts";
import { Partition, Site } from "./suite-env.ts";

export { Site };

export const Cache = Redis("Cache", {
  project: Site,
  environment: Partition,
});

export const REDIS_KEY = "alchemy-marker";
export const REDIS_VALUE = "hello-from-redis";
