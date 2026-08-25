import * as AWS from "@/AWS";
import { Domain, Project } from "@/AWS/DataZone";
import * as Test from "@/Test/Alchemy";
import * as datazone from "@distilled.cloud/aws/datazone";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: AWS.providers() });

const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

// Once the parent domain is deleted, GetProject is reported as
// AccessDeniedException rather than ResourceNotFoundException — DataZone
// checks domain-scoped auth before existence. Both mean "absent".
const findProject = (domainId: string, projectId: string) =>
  datazone
    .getProject({ domainIdentifier: domainId, identifier: projectId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      Effect.catchTag("AccessDeniedException", () => Effect.succeed(undefined)),
    );

test.provider(
  "create project in a domain, update description, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // 1. Deploy a domain and a project inside it.
      const result = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("ProjectTestDomain", {
            description: "alchemy datazone project test",
          });
          const project = yield* Project("TestProject", {
            domainId: domain.domainId,
            description: "analytics project",
          });
          return {
            domainId: domain.domainId,
            projectId: project.projectId,
            projectName: project.name,
            projectStatus: project.projectStatus,
            domainUnitId: project.domainUnitId,
          };
        }),
      );

      expect(result.projectId).toBeDefined();
      expect(result.projectStatus).toBe("ACTIVE");

      // out-of-band: project exists inside the domain.
      const created = yield* findProject(result.domainId, result.projectId);
      expect(created).toBeDefined();
      expect(unredact(created!.name)).toBe(result.projectName);
      expect(
        created!.description === undefined
          ? undefined
          : unredact(created!.description),
      ).toBe("analytics project");

      // 2. Update the description — converges via updateProject, same project.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const domain = yield* Domain("ProjectTestDomain", {
            description: "alchemy datazone project test",
          });
          const project = yield* Project("TestProject", {
            domainId: domain.domainId,
            description: "analytics project (updated)",
          });
          return { projectId: project.projectId };
        }),
      );
      expect(updated.projectId).toBe(result.projectId);

      const observed = yield* findProject(result.domainId, result.projectId);
      expect(
        observed!.description === undefined
          ? undefined
          : unredact(observed!.description),
      ).toBe("analytics project (updated)");

      // 3. Destroy — the project is deleted before its domain.
      yield* stack.destroy();
      const gone = yield* findProject(result.domainId, result.projectId);
      expect(gone === undefined || gone.projectStatus === "DELETING").toBe(
        true,
      );
    }),
  { timeout: 480_000 },
);
