import type {
  EnvironmentsReadCapability,
  FilesystemCapability,
  HttpClientCapability,
  SecretsCapability,
  SourceControlCapability,
  VcsCapability,
} from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";

export class WorkflowVcsCapability extends Context.Service<WorkflowVcsCapability, VcsCapability>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowVcsCapability",
) {}

export class WorkflowSourceControlCapability extends Context.Service<
  WorkflowSourceControlCapability,
  SourceControlCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowSourceControlCapability",
) {}

export class WorkflowEnvironmentsReadCapability extends Context.Service<
  WorkflowEnvironmentsReadCapability,
  EnvironmentsReadCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowEnvironmentsReadCapability",
) {}

export class WorkflowFilesystemCapability extends Context.Service<
  WorkflowFilesystemCapability,
  FilesystemCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowFilesystemCapability",
) {}

export class WorkflowSecretsCapability extends Context.Service<
  WorkflowSecretsCapability,
  SecretsCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowSecretsCapability",
) {}

export class WorkflowHttpClientCapability extends Context.Service<
  WorkflowHttpClientCapability,
  HttpClientCapability
>()(
  "@t3tools/fixture-workflow-boards/server/workflow/Services/WorkflowCapabilities/WorkflowHttpClientCapability",
) {}
