import * as account from "@distilled.cloud/aws/account";
import * as Layer from "effect/Layer";
import { makeAccountHttpBinding } from "./BindingHttp.ts";
import { GetRegionOptStatus } from "./GetRegionOptStatus.ts";

export const GetRegionOptStatusHttp = Layer.effect(
  GetRegionOptStatus,
  makeAccountHttpBinding({
    capability: "GetRegionOptStatus",
    iamActions: ["account:GetRegionOptStatus"],
    operation: account.getRegionOptStatus,
  }),
);
