import * as Region from "@distilled.cloud/aws/Region";
import * as Layer from "effect/Layer";
import { AWSEnvironment } from "./Environment.ts";

export { AWS_REGION, type RegionID } from "./Environment.ts";
export { Region } from "@distilled.cloud/aws/Region";

export const of = (region: string) => Layer.succeed(Region.Region, region);

export const fromEnvOrElse = (region: string) =>
  Layer.succeed(Region.Region, process.env.AWS_REGION ?? region);

/**
 * Derive the AWS region from the surrounding {@link AWSEnvironment}.
 */
export const fromEnvironment = Layer.effect(
  Region.Region,
  AWSEnvironment.useSync((env) => env.region),
);
