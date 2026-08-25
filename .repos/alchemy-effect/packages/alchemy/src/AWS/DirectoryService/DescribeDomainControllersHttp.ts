import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryHttpBinding } from "./BindingHttp.ts";
import { DescribeDomainControllers } from "./DescribeDomainControllers.ts";

export const DescribeDomainControllersHttp = Layer.effect(
  DescribeDomainControllers,
  makeDirectoryHttpBinding({
    tag: "AWS.DirectoryService.DescribeDomainControllers",
    operation: ds.describeDomainControllers,
    actions: ["ds:DescribeDomainControllers"],
  }),
);
