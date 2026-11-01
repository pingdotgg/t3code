import { GcpEnvironment } from "@/GCP/Environment";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const currentProject = GcpEnvironment.current.pipe(
  Effect.map((env) => env.project),
);

// Access policies live on the organization and need Access Context Manager
// admin there; the testing credentials get Forbidden "The caller does not have
// permission". Set GOOGLE_ORGANIZATION_ID when the credentials administer the
// org to run the lifecycles.
export const runLifecycle = !!process.env.GOOGLE_ORGANIZATION_ID;

export const runProbe = !runLifecycle;

export const lastSegment = (value: string) => {
  const trimmed = value.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
};

export const projectContext = () =>
  currentProject.pipe(
    Effect.flatMap((project) =>
      resourcemanager.getProjects({ name: `projects/${project}` }),
    ),
    Effect.map((resource) => {
      const parent = resource.parent ?? "";
      return {
        projectNumber: lastSegment(resource.name ?? ""),
        parent,
        organization: parent.startsWith("organizations/") ? parent : undefined,
      };
    }),
    Effect.catchTag("NotFound", () =>
      Effect.succeed({
        projectNumber: "",
        parent: "",
        organization: undefined as string | undefined,
      }),
    ),
  );
