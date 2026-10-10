import * as ec2 from "@distilled.cloud/aws/ec2";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import { GetAmi } from "./GetAmi.ts";
import type { FindImageOptions } from "./Image.ts";
import { isInstance } from "./Instance.ts";

// Bespoke (not the shared scaffold): the lookup filters and sorts the
// paginated image list to pick the newest available match, and the binding
// is account-scoped — there is no resource to bind, only options.
export const GetAmiHttp = Layer.effect(
  GetAmi,
  Effect.gen(function* () {
    const describeImages = yield* ec2.describeImages;

    return Effect.fn(function* (options: FindImageOptions) {
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host) || isInstance(host)) {
          yield* host.bind`Allow(${host}, AWS.EC2.GetAmi)`({
            policyStatements: [
              {
                Effect: "Allow",
                Action: ["ec2:DescribeImages"],
                Resource: ["*"],
              },
            ],
          });
        }
      }

      const {
        owners,
        name,
        architecture = "x86_64",
        rootDeviceType = "ebs",
        virtualizationType = "hvm",
      } = options;

      return Effect.fn("AWS.EC2.GetAmi")(function* () {
        const response = yield* describeImages({
          Owners: owners,
          Filters: [
            { Name: "name", Values: [...name] },
            { Name: "architecture", Values: [architecture] },
            { Name: "state", Values: ["available"] },
            { Name: "root-device-type", Values: [rootDeviceType] },
            { Name: "virtualization-type", Values: [virtualizationType] },
          ],
        });
        return (response.Images ?? [])
          .slice()
          .sort((a: ec2.Image, b: ec2.Image) =>
            String(b.CreationDate ?? "").localeCompare(
              String(a.CreationDate ?? ""),
            ),
          )[0];
      });
    });
  }),
);
