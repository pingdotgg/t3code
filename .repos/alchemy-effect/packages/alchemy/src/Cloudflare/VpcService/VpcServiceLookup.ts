import * as connectivity from "@distilled.cloud/cloudflare/connectivity";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Output from "../../Output.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { formatVpcService, type Attributes } from "./VpcService.ts";

export type VpcServiceLookupProps =
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
 * The resolved value of a {@link lookup} — the service's {@link Attributes}
 * branded with the VpcService resource `Type`, so Worker binding
 * classification treats it exactly like the managed resource.
 */
export interface VpcServiceLookup extends Attributes {
  readonly Type: "Cloudflare.VpcService.VpcService";
}

const toLookup = (attrs: Attributes): VpcServiceLookup => ({
  ...attrs,
  Type: "Cloudflare.VpcService.VpcService",
});

/**
 * Look up an existing Cloudflare VPC service (managed outside this stack)
 * without managing its lifecycle — the data-source form (what Terraform
 * calls a data source and Pulumi an invoke). Reads the service by
 * `serviceId` or `name` and returns an `Output` of its {@link Attributes},
 * resolved during plan/deploy and inert inside deployed bundles. Place it
 * in a Worker's `env` to attach a `vpc_service` binding.
 * **Example:** Look up by ID
 * ```typescript
 * const service = Cloudflare.VpcService.lookup({
 *   serviceId: "123e4567-e89b-12d3-a456-426614174000",
 * });
 * ```
 *
 * **Example:** Look up by name
 * ```typescript
 * const service = Cloudflare.VpcService.lookup({ name: "my-vpc-service" });
 * ```
 *
 * **Example:** Bind to a Worker
 * ```typescript
 * const worker = yield* Cloudflare.Worker("Worker", {
 *   main: "./src/worker.ts",
 *   env: { VPC: Cloudflare.VpcService.lookup({ name: "my-vpc-service" }) },
 * });
 * ```
 *
 * @resource
 * @product Workers VPC
 * @category Network
 */
export const lookup = (props: VpcServiceLookupProps) =>
  Output.fromEffect(
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
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
        return toLookup(formatVpcService(match, accountId));
      }
      const result = yield* connectivity.getDirectoryService({
        accountId,
        serviceId: props.serviceId,
      });
      return toLookup(formatVpcService(result, accountId));
    }).pipe(Effect.orDie),
  );
