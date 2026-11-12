import * as devopsguru from "@distilled.cloud/aws/devops-guru";
import * as Layer from "effect/Layer";
import { makeDevOpsGuruAccountHttpBinding } from "./BindingHttp.ts";
import { ListMonitoredResources } from "./ListMonitoredResources.ts";

export const ListMonitoredResourcesHttp = Layer.effect(
  ListMonitoredResources,
  makeDevOpsGuruAccountHttpBinding({
    tag: "AWS.DevOpsGuru.ListMonitoredResources",
    operation: devopsguru.listMonitoredResources,
    actions: ["devops-guru:ListMonitoredResources"],
  }),
);
