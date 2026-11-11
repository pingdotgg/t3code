import * as codeconnections from "@distilled.cloud/aws/codeconnections";
import * as Layer from "effect/Layer";
import { makeRepositoryLinkScopedHttpBinding } from "./BindingHttp.ts";
import { GetRepositorySyncStatus } from "./GetRepositorySyncStatus.ts";

export const GetRepositorySyncStatusHttp = Layer.effect(
  GetRepositorySyncStatus,
  makeRepositoryLinkScopedHttpBinding({
    tag: "AWS.CodeConnections.GetRepositorySyncStatus",
    actions: ["codeconnections:GetRepositorySyncStatus"],
    operation: codeconnections.getRepositorySyncStatus,
  }),
);
