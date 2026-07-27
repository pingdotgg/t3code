import * as ds from "@distilled.cloud/aws/directory-service";
import * as Layer from "effect/Layer";
import { makeDirectoryHttpBinding } from "./BindingHttp.ts";
import { CreateSnapshot } from "./CreateSnapshot.ts";

export const CreateSnapshotHttp = Layer.effect(
  CreateSnapshot,
  makeDirectoryHttpBinding({
    tag: "AWS.DirectoryService.CreateSnapshot",
    operation: ds.createSnapshot,
    actions: ["ds:CreateSnapshot"],
  }),
);
