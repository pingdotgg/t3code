import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListFargateProfiles } from "./ListFargateProfiles.ts";

export const ListFargateProfilesHttp = Layer.effect(
  ListFargateProfiles,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListFargateProfiles",
    operation: eks.listFargateProfiles,
    actions: ["eks:ListFargateProfiles"],
    key: "clusterName",
    scope: "cluster",
  }),
);
