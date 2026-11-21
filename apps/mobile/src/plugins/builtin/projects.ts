import { defineNativeBuiltinPlugin } from "./define";

export const nativeProjectsPlugin = defineNativeBuiltinPlugin("t3.projects", [
  "native.features.projects.add-project-source-route",
  "native.features.projects.add-project-destination-route",
  "native.features.projects.add-project-local-route",
  "native.features.projects.add-project-new-route",
  "native.features.projects.add-project-repository-route",
]);
