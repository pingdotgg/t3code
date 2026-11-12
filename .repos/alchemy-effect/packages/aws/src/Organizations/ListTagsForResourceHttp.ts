import * as organizations from "@distilled.cloud/aws/organizations";
import * as Layer from "effect/Layer";
import { makeOrganizationsHttpBinding } from "./BindingHttp.ts";
import { ListTagsForResource } from "./ListTagsForResource.ts";

export const ListTagsForResourceHttp = Layer.effect(
  ListTagsForResource,
  makeOrganizationsHttpBinding({
    capability: "ListTagsForResource",
    iamActions: ["organizations:ListTagsForResource"],
    operation: organizations.listTagsForResource,
  }),
);
