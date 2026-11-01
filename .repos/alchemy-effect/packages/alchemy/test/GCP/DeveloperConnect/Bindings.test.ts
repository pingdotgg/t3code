import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as Core from "@/Test/Core";
import * as crm from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import type * as developerconnect from "@distilled.cloud/gcp/developerconnect_v1";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { dockerAvailable, expectProbe } from "../bindingHost.ts";
import DeveloperConnectBindingsHost, {
  linkEnabled,
  Source,
} from "./fixtures/bindings-host.ts";

const testOptions = { providers: GCP.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "DeveloperConnectBindings");

let baseUrl: string;
let hostAccount: string;
let project: string;

/** The token/ref bindings grant their roles on the project. */
const expectProjectGrants = Effect.gen(function* () {
  const policy = yield* crm.getIamPolicyProjects({
    resource: `projects/${project}`,
    body: { options: { requestedPolicyVersion: 3 } },
  });
  const roles = (policy.bindings ?? [])
    .filter((binding) =>
      (binding.members ?? []).includes(`serviceAccount:${hostAccount}`),
    )
    .map((binding) => ({ role: binding.role, condition: binding.condition }))
    .sort((a, b) => (a.role ?? "").localeCompare(b.role ?? ""));
  expect(roles).toEqual([
    { role: "roles/developerconnect.readTokenAccessor", condition: undefined },
    { role: "roles/developerconnect.tokenAccessor", condition: undefined },
    { role: "roles/developerconnect.user", condition: undefined },
  ]);
});

describe.skipIf(!dockerAvailable || !linkEnabled)(
  "DeveloperConnect Bindings",
  {
    tags: [
      "provider:gcp",
      "provider:gcp:developerconnect",
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
            const host = yield* DeveloperConnectBindingsHost;
            const link = yield* Source;
            return {
              uri: host.uri,
              serviceAccount: host.serviceAccount,
              project: link.project,
            };
          }),
        );
        baseUrl = out.uri!;
        hostAccount = out.serviceAccount!;
        project = out.project;
      }),
      { timeout: 900_000 },
    );

    afterAll(sharedStack.destroy(), { timeout: 600_000 });

    describe("FetchReadToken", () => {
      test.provider(
        "mints a read token as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            expect(yield* expectProbe(baseUrl, "fetchReadToken")).toEqual({
              hasToken: true,
            });
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("FetchReadWriteToken", () => {
      test.provider(
        "mints a read-write token as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            expect(yield* expectProbe(baseUrl, "fetchReadWriteToken")).toEqual({
              hasToken: true,
            });
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
          timeout: 600_000,
        },
      );
    });

    describe("FetchGitRefs", () => {
      test.provider(
        "lists branches as the host's service account",
        (_stack) =>
          Effect.gen(function* () {
            const refs =
              yield* expectProbe<developerconnect.FetchGitRefsResponse>(
                baseUrl,
                "fetchGitRefs",
              );
            // Every cloneable repository has at least its default branch.
            expect(refs.refNames?.length).toBeGreaterThan(0);
            yield* expectProjectGrants;
          }),
        {
          tags: ["provider:gcp", "provider:gcp:developerconnect", "live"],
          timeout: 600_000,
        },
      );
    });
  },
);
