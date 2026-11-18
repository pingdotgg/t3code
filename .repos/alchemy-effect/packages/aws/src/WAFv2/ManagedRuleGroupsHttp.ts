import * as wafv2 from "@distilled.cloud/aws/wafv2";
import * as Layer from "effect/Layer";
import { makeWafv2AccountHttpBinding } from "./BindingHttp.ts";
import {
  DescribeAllManagedProducts,
  DescribeManagedProductsByVendor,
  DescribeManagedRuleGroup,
  ListAvailableManagedRuleGroups,
  ListAvailableManagedRuleGroupVersions,
} from "./ManagedRuleGroups.ts";

export const DescribeManagedRuleGroupHttp = Layer.effect(
  DescribeManagedRuleGroup,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.DescribeManagedRuleGroup",
    operation: wafv2.describeManagedRuleGroup,
    actions: ["wafv2:DescribeManagedRuleGroup"],
  }),
);

export const ListAvailableManagedRuleGroupsHttp = Layer.effect(
  ListAvailableManagedRuleGroups,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.ListAvailableManagedRuleGroups",
    operation: wafv2.listAvailableManagedRuleGroups,
    actions: ["wafv2:ListAvailableManagedRuleGroups"],
  }),
);

export const ListAvailableManagedRuleGroupVersionsHttp = Layer.effect(
  ListAvailableManagedRuleGroupVersions,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.ListAvailableManagedRuleGroupVersions",
    operation: wafv2.listAvailableManagedRuleGroupVersions,
    actions: ["wafv2:ListAvailableManagedRuleGroupVersions"],
  }),
);

export const DescribeAllManagedProductsHttp = Layer.effect(
  DescribeAllManagedProducts,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.DescribeAllManagedProducts",
    operation: wafv2.describeAllManagedProducts,
    actions: ["wafv2:DescribeAllManagedProducts"],
  }),
);

export const DescribeManagedProductsByVendorHttp = Layer.effect(
  DescribeManagedProductsByVendor,
  makeWafv2AccountHttpBinding({
    tag: "AWS.WAFv2.DescribeManagedProductsByVendor",
    operation: wafv2.describeManagedProductsByVendor,
    actions: ["wafv2:DescribeManagedProductsByVendor"],
  }),
);
