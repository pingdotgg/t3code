import * as GCP from "@/GCP";
import { GcpEnvironment } from "@/GCP/Environment";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as parametermanager from "@distilled.cloud/gcp/parametermanager_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import ParameterManagerBindingsHost, {
  AppConfig,
  PAYLOAD,
  V1,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "ParameterManagerBindings");

let baseUrl: string;
let member: string;
let parameterName: string;
let versionName: string;

const scoped = (name: string) =>
  `resource.name == "${name}" || resource.name.startsWith("${name}/")`;

/** `[role, condition expression]` the host holds on the project. */
const hostProjectGrants = Effect.gen(function* () {
  const { project } = yield* GcpEnvironment.current;
  const policy = yield* resourcemanager.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  return (policy.bindings ?? [])
    .filter((binding) => (binding.members ?? []).includes(member))
    .map((binding) => [binding.role, binding.condition?.expression]);
});

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

describe.skipIf(!dockerAvailable)(
  "ParameterManager Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:parametermanager",
      "provider:gcp:run",
      "live",
    ],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        const out = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const host = yield* ParameterManagerBindingsHost;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              parameter: (yield* AppConfig).name,
              version: (yield* V1).name,
            };
          }),
        );
        baseUrl = out.uri!;
        member = `serviceAccount:${out.serviceAccount!}`;
        parameterName = out.parameter;
        versionName = out.version;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("GetParameter", () => {
      test.provider(
        "reads the parameter, granted parameterViewer scoped to it",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<parametermanager.Parameter>(
              baseUrl,
              "getParameter",
            );
            expect(live.name).toEqual(parameterName);
            expect(live.format).toEqual("JSON");

            expect(yield* hostProjectGrants).toContainEqual([
              "roles/parametermanager.parameterViewer",
              scoped(parameterName),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("GetParameterVersion", () => {
      test.provider(
        "reads the version payload, granted parameterViewer scoped to it",
        (_stack) =>
          Effect.gen(function* () {
            const live = yield* expectProbe<parametermanager.ParameterVersion>(
              baseUrl,
              "getParameterVersion",
            );
            expect(live.name).toEqual(versionName);
            expect(live.payload?.data).toEqual(base64(PAYLOAD));

            expect(yield* hostProjectGrants).toContainEqual([
              "roles/parametermanager.parameterViewer",
              scoped(versionName),
            ]);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("RenderParameterVersion", () => {
      test.provider(
        "renders the version, granted parameterAccessor scoped to it",
        (_stack) =>
          Effect.gen(function* () {
            const rendered =
              yield* expectProbe<parametermanager.RenderParameterVersionResponse>(
                baseUrl,
                "renderParameterVersion",
              );
            expect(rendered.parameterVersion).toEqual(versionName);
            expect(rendered.renderedPayload).toEqual(base64(PAYLOAD));

            // Out of band: the deployer renders the same payload.
            const direct =
              yield* parametermanager.renderProjectsLocationsParametersVersions(
                { name: versionName },
              );
            expect(direct.renderedPayload).toEqual(rendered.renderedPayload);

            const grants = yield* hostProjectGrants;
            expect(grants).toContainEqual([
              "roles/parametermanager.parameterAccessor",
              scoped(versionName),
            ]);
            // Every grant the host holds is condition-scoped.
            expect(grants.filter(([, expression]) => !expression)).toEqual([]);
            expect(grants).toHaveLength(3);
          }),
        {
          tags: ["provider:gcp", "provider:gcp:parametermanager", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
