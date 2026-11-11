import { createHash } from "node:crypto";
import * as GCP from "@alchemy.run/gcp";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Deleted pools and providers are soft-deleted (state DELETED) for 30 days.
const waitUntilDeleted = <R>(get: Effect.Effect<{ state?: string }, { _tag: string }, R>) =>
  get.pipe(
    Effect.map((resource) => (resource.state === "DELETED" ? "gone" : "found")),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

// Reads of a just-created pool or provider can return NotFound for a few seconds.
const retryNotFound = {
  while: (error: { _tag: string }) => error._tag === "NotFound",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
};
const getPool = (name: string) =>
  iam.getProjectsLocationsWorkloadIdentityPools({ name }).pipe(Effect.retry(retryNotFound));
const getProvider = (name: string) =>
  iam
    .getProjectsLocationsWorkloadIdentityPoolsProviders({ name })
    .pipe(Effect.retry(retryNotFound));

const stateOf = (name: string) =>
  iam.getProjectsLocationsWorkloadIdentityPoolsProviders({ name }).pipe(
    Effect.map((provider) => provider.state),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

// Provider state reads lag a few seconds behind delete and undelete.
const waitForState = (name: string, state: "ACTIVE" | "DELETED") =>
  stateOf(name).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (current) => current === state,
      times: 10,
    }),
  );

// Pool ids stay reserved for 30 days after delete, so an explicit id must be
// unique per stage; the engine-generated ids used elsewhere already are.
const poolIdFor = (stage: string) =>
  `wip-${createHash("sha256").update(stage).digest("hex").slice(0, 10)}`;

const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

test.provider(
  "create, update, and delete a workload identity pool and provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (options: { displayName: string; condition: string; disabled?: boolean }) =>
        stack.deploy(
          Effect.gen(function* () {
            const pool = yield* GCP.IAM.WorkloadIdentityPool("Ci", {
              displayName: options.displayName,
              description: "test pool",
              disabled: options.disabled,
            });
            const provider = yield* GCP.IAM.WorkloadIdentityProvider("Github", {
              workloadIdentityPoolId: pool.workloadIdentityPoolId,
              displayName: "GitHub OIDC",
              attributeMapping: {
                "google.subject": "assertion.sub",
                "attribute.repository": "assertion.repository",
              },
              attributeCondition: options.condition,
              oidc: { issuerUri: GITHUB_ISSUER },
            });
            // Federated identities from one repository may impersonate it.
            const deployer = yield* GCP.IAM.ServiceAccount("Deployer", {});
            yield* GCP.IAM.Member("GithubDeployer", {
              kind: "iam.serviceAccount",
              name: deployer.name,
              role: "roles/iam.workloadIdentityUser",
              member: Output.interpolate`principalSet://iam.googleapis.com/${pool.name}/attribute.repository/alchemy-run/alchemy`,
            });
            return { pool, provider, deployer };
          }),
        );

      const created = yield* deploy({
        displayName: "Alchemy CI",
        condition: `assertion.repository == "alchemy-run/alchemy"`,
      });

      expect(created.pool.workloadIdentityPoolId).toMatch(/^[a-z][a-z0-9-]{2,30}[a-z0-9]$/);
      // GCP names pools by project number, which principalSet members need.
      expect(created.pool.name).toMatch(
        new RegExp(
          `^projects/\\d+/locations/global/workloadIdentityPools/${created.pool.workloadIdentityPoolId}$`,
        ),
      );
      expect(created.provider.name).toEqual(
        `${created.pool.name}/providers/${created.provider.workloadIdentityPoolProviderId}`,
      );
      const policy = yield* iam.getIamPolicyProjectsServiceAccounts({
        resource: created.deployer.name,
      });
      expect(
        policy.bindings?.find((binding) => binding.role === "roles/iam.workloadIdentityUser")
          ?.members,
      ).toContain(
        `principalSet://iam.googleapis.com/${created.pool.name}/attribute.repository/alchemy-run/alchemy`,
      );
      expect(created.pool.displayName).toEqual("Alchemy CI");
      expect(created.pool.description).toEqual("test pool");
      expect(created.pool.disabled).toEqual(false);
      expect(created.provider.workloadIdentityPoolId).toEqual(created.pool.workloadIdentityPoolId);
      expect(created.provider.oidc?.issuerUri).toEqual(GITHUB_ISSUER);
      expect(created.provider.attributeMapping).toEqual({
        "google.subject": "assertion.sub",
        "attribute.repository": "assertion.repository",
      });

      const fetchedPool = yield* getPool(created.pool.name);
      expect(fetchedPool.state).toEqual("ACTIVE");
      expect(fetchedPool.description).toMatch(/^\[alchemy .*alchemy-id=\S*ci\]\ntest pool$/);
      const fetchedProvider = yield* getProvider(created.provider.name);
      expect(fetchedProvider.attributeCondition).toEqual(
        `assertion.repository == "alchemy-run/alchemy"`,
      );

      // Updates happen in place.
      const updated = yield* deploy({
        displayName: "Alchemy CI (prod)",
        condition: `assertion.repository == "alchemy-run/alchemy" && assertion.ref == "refs/heads/main"`,
        disabled: true,
      });
      expect(updated.pool.name).toEqual(created.pool.name);
      expect(updated.pool.displayName).toEqual("Alchemy CI (prod)");
      expect(updated.pool.disabled).toEqual(true);
      expect(updated.provider.name).toEqual(created.provider.name);
      expect(updated.provider.attributeCondition).toMatch(/refs\/heads\/main/);

      const refetchedProvider = yield* getProvider(created.provider.name);
      expect(refetchedProvider.attributeCondition).toMatch(/refs\/heads\/main/);
      const refetchedPool = yield* getPool(created.pool.name);
      expect(refetchedPool.disabled).toEqual(true);

      yield* stack.destroy();

      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPoolsProviders({ name: created.provider.name }),
        ),
      ).toEqual("gone");
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPools({ name: created.pool.name }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 180_000 },
);

test.provider(
  "replace, restore, and remove a workload identity provider",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (options: {
        providerId: string;
        condition: string;
        withAws?: boolean;
        withOidc?: boolean;
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const pool = yield* GCP.IAM.WorkloadIdentityPool("Pool", {});
            const oidc =
              options.withOidc === false
                ? undefined
                : yield* GCP.IAM.WorkloadIdentityProvider("Oidc", {
                    workloadIdentityPoolId: pool.workloadIdentityPoolId,
                    workloadIdentityPoolProviderId: options.providerId,
                    attributeMapping: { "google.subject": "assertion.sub" },
                    attributeCondition: options.condition,
                    oidc: {
                      issuerUri: GITHUB_ISSUER,
                      allowedAudiences: ["https://github.com/alchemy-run"],
                    },
                  });
            const aws = options.withAws
              ? yield* GCP.IAM.WorkloadIdentityProvider("Aws", {
                  workloadIdentityPoolId: pool.workloadIdentityPoolId,
                  attributeMapping: { "google.subject": "assertion.arn" },
                  aws: { accountId: "123456789012" },
                })
              : undefined;
            return { pool, oidc, aws };
          }),
        );

      const first = yield* deploy({
        providerId: "oidc-a",
        condition: `assertion.repository_owner == "alchemy-run"`,
      });
      const nameA = first.oidc!.name;
      expect(first.oidc!.workloadIdentityPoolProviderId).toEqual("oidc-a");
      expect(first.oidc!.oidc?.allowedAudiences).toEqual(["https://github.com/alchemy-run"]);
      expect(yield* waitForState(nameA, "ACTIVE")).toEqual("ACTIVE");

      // A new provider id replaces the provider; the old one is soft-deleted.
      const second = yield* deploy({
        providerId: "oidc-b",
        condition: `assertion.repository_owner == "alchemy-run"`,
      });
      const nameB = second.oidc!.name;
      expect(nameB).not.toEqual(nameA);
      expect(yield* waitForState(nameB, "ACTIVE")).toEqual("ACTIVE");
      expect(yield* waitForState(nameA, "DELETED")).toEqual("DELETED");

      // Going back to the soft-deleted id restores it and syncs the new
      // condition onto the restored provider.
      const restored = yield* deploy({
        providerId: "oidc-a",
        condition: `assertion.repository == "alchemy-run/alchemy"`,
      });
      expect(restored.oidc!.name).toEqual(nameA);
      expect(restored.oidc!.attributeCondition).toEqual(
        `assertion.repository == "alchemy-run/alchemy"`,
      );
      const fetchedA = yield* getProvider(nameA);
      expect(fetchedA.state).toEqual("ACTIVE");
      expect(fetchedA.attributeCondition).toEqual(`assertion.repository == "alchemy-run/alchemy"`);
      expect(yield* waitForState(nameB, "DELETED")).toEqual("DELETED");

      // An AWS issuer alongside it, then removing the OIDC provider from the
      // stack deletes only that provider.
      const withAws = yield* deploy({
        providerId: "oidc-a",
        condition: `assertion.repository == "alchemy-run/alchemy"`,
        withAws: true,
      });
      expect(withAws.aws!.aws).toEqual({ accountId: "123456789012" });
      expect(withAws.aws!.workloadIdentityPoolProviderId).toMatch(/^alchemy-aws-/);
      const fetchedAws = yield* getProvider(withAws.aws!.name);
      expect(fetchedAws.aws?.accountId).toEqual("123456789012");

      yield* deploy({ providerId: "oidc-a", condition: "", withAws: true, withOidc: false });
      expect(yield* waitForState(nameA, "DELETED")).toEqual("DELETED");
      expect(yield* waitForState(withAws.aws!.name, "ACTIVE")).toEqual("ACTIVE");

      yield* stack.destroy();
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPoolsProviders({ name: withAws.aws!.name }),
        ),
      ).toEqual("gone");
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPools({ name: withAws.pool.name }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 300_000 },
);

test.provider(
  "redeploying a destroyed pool id restores the soft-deleted pool",
  (stack) =>
    Effect.gen(function* () {
      const poolId = poolIdFor(stack.stage);
      yield* stack.destroy();

      const deploy = (description: string) =>
        stack.deploy(
          GCP.IAM.WorkloadIdentityPool("Named", {
            workloadIdentityPoolId: poolId,
            description,
          }),
        );

      const created = yield* deploy("first");
      expect(created.workloadIdentityPoolId).toEqual(poolId);
      yield* stack.destroy();
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPools({ name: created.name }),
        ),
      ).toEqual("gone");

      // The id is still reserved; the redeploy undeletes the pool instead of
      // failing with ALREADY_EXISTS.
      const restored = yield* deploy("second");
      expect(restored.name).toEqual(created.name);
      expect(restored.description).toEqual("second");
      const fetched = yield* getPool(created.name);
      expect(fetched.state).toEqual("ACTIVE");
      expect(fetched.description).toMatch(/\nsecond$/);

      yield* stack.destroy();
      expect(
        yield* waitUntilDeleted(
          iam.getProjectsLocationsWorkloadIdentityPools({ name: created.name }),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:iam", "live"], timeout: 300_000 },
);
