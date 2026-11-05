import * as eks from "@distilled.cloud/aws/eks";
import * as Layer from "effect/Layer";
import { makeEKSClusterHttpBinding } from "./BindingHttp.ts";
import { ListIdentityProviderConfigs } from "./ListIdentityProviderConfigs.ts";

export const ListIdentityProviderConfigsHttp = Layer.effect(
  ListIdentityProviderConfigs,
  makeEKSClusterHttpBinding({
    tag: "AWS.EKS.ListIdentityProviderConfigs",
    operation: eks.listIdentityProviderConfigs,
    actions: ["eks:ListIdentityProviderConfigs"],
    key: "clusterName",
    scope: "cluster",
  }),
);
