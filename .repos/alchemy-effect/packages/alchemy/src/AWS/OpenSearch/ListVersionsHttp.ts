import * as opensearch from "@distilled.cloud/aws/opensearch";
import * as Layer from "effect/Layer";
import { makeOpenSearchHttpBinding } from "./BindingHttp.ts";
import { ListVersions } from "./ListVersions.ts";

export const ListVersionsHttp = Layer.effect(
  ListVersions,
  makeOpenSearchHttpBinding({
    tag: "AWS.OpenSearch.ListVersions",
    operation: opensearch.listVersions,
    actions: ["es:ListVersions"],
  }),
);
