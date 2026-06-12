import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { formatVpcService, type VpcServiceAttributes } from "./VpcService.ts";

export type VpcServiceRefProps =
  | {
      /**
       * The Cloudflare-assigned ID for the VPC service.
       */
      serviceId: string;
    }
  | {
      /**
       * The display name of the VPC service.
       */
      name: string;
    };

/**
 * Reference to an existing VPC service. Same shape as the resource's outputs.
 */
export type VpcServiceRef = VpcServiceAttributes;

/**
 * Reference an existing Cloudflare VPC service without managing its lifecycle.
 *
 * @example Reference by ID
 * ```typescript
 * const service = yield* Cloudflare.VpcServiceRef({
 *   serviceId: "123e4567-e89b-12d3-a456-426614174000",
 * });
 * ```
 *
 * @example Reference by name
 * ```typescript
 * const service = yield* Cloudflare.VpcServiceRef({
 *   name: "my-vpc-service",
 * });
 * ```
 */
export const VpcServiceRef = (props: VpcServiceRefProps) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;
    if ("name" in props) {
      const match = yield* connectivity.listDirectoryServices
        .items({ accountId })
        .pipe(
          Stream.filter((s) => s.name === props.name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
      if (!match) {
        return yield* Effect.die(`VPC service "${props.name}" not found`);
      }
      return formatVpcService(match, accountId);
    }
    const result = yield* connectivity.getDirectoryService({
      accountId,
      serviceId: props.serviceId,
    });
    return formatVpcService(result, accountId);
  });
