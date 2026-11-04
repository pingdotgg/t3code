import * as s3tables from "@distilled.cloud/aws/s3tables";
import * as Layer from "effect/Layer";
import { makeS3TablesTableBucketHttpBinding } from "./BindingHttp.ts";
import { ListNamespaces } from "./ListNamespaces.ts";

export const ListNamespacesHttp = Layer.effect(
  ListNamespaces,
  makeS3TablesTableBucketHttpBinding({
    tag: "AWS.S3Tables.ListNamespaces",
    operation: s3tables.listNamespaces,
    actions: ["s3tables:ListNamespaces"],
  }),
);
