import { GcpEnvironment } from "@/GCP/Environment";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

// Repositories live in a Secure Source Manager instance (billed, ~30
// minutes to provision) and the API is disabled on the testing project:
// creates fail with Forbidden "Secure Source Manager API has not been used in
// project ... before or it is disabled". Set GCP_TEST_SECURE_SOURCE_MANAGER=1
// plus GCP_TEST_SECURE_SOURCE_MANAGER_REPO on a project with an instance.
export const runLifecycle =
  !process.env.FAST && !!process.env.GCP_TEST_SECURE_SOURCE_MANAGER;

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

export const missingRepoOf = (project: string) =>
  `projects/${project}/locations/us-central1/repositories/alchemy-missing-ssm-repo`;

export const missingIssueOf = (project: string) =>
  `${missingRepoOf(project)}/issues/12345`;

export const missingPullRequestOf = (project: string) =>
  `${missingRepoOf(project)}/pullRequests/12345`;

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);
