import * as AWS from "@/AWS";
import { ConfigurationSet, Tenant, TenantResourceAssociation } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

const associatedArns = (tenantName: string) =>
  sesv2.listTenantResources.pages({ TenantName: tenantName }).pipe(
    Stream.runCollect,
    Effect.map((pages) =>
      Array.from(pages)
        .flatMap((page) => page.TenantResources ?? [])
        .flatMap((resource) =>
          resource.ResourceArn ? [resource.ResourceArn] : [],
        ),
    ),
  );

const isAssociated = (tenantName: string, resourceArn: string) =>
  associatedArns(tenantName).pipe(
    Effect.map((arns) => arns.includes(resourceArn)),
  );

test.provider(
  "tenant resource association lifecycle: associate a config set, verify, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { tenant, configSet } = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          const configSet = yield* ConfigurationSet("Config", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: configSet.configurationSetArn,
          });
          return { tenant, configSet };
        }),
      );

      // out-of-band verification via distilled. The association is eventually
      // consistent, so poll the SUCCESS value — `Effect.retry`'s `while` reads
      // the error channel and would never see the boolean.
      const found = yield* isAssociated(
        tenant.tenantName,
        configSet.configurationSetArn,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (associated) => associated,
          times: 10,
        }),
      );
      expect(found).toBe(true);

      yield* stack.destroy();

      // The tenant and its associations are gone after destroy; listing a
      // deleted tenant surfaces NotFoundException, treated as "not associated".
      const gone = yield* isAssociated(
        tenant.tenantName,
        configSet.configurationSetArn,
      ).pipe(Effect.catchTag("NotFoundException", () => Effect.succeed(false)));
      expect(gone).toBe(false);
    }),
  { timeout: 120_000 },
);

test.provider(
  "changing the resource ARN replaces the association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { tenant, first, second } = yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          const first = yield* ConfigurationSet("ConfigA", {});
          const second = yield* ConfigurationSet("ConfigB", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: first.configurationSetArn,
          });
          return { tenant, first, second };
        }),
      );

      // Re-point the association at the second config set. Both config sets
      // stay deployed across the replacement so the engine does not deadlock
      // removing a dependency during a replace.
      yield* stack.deploy(
        Effect.gen(function* () {
          const tenant = yield* Tenant("Customer", {});
          yield* ConfigurationSet("ConfigA", {});
          const second = yield* ConfigurationSet("ConfigB", {});
          yield* TenantResourceAssociation("Link", {
            tenantName: tenant.tenantName,
            resourceArn: second.configurationSetArn,
          });
          return tenant;
        }),
      );

      const arns = yield* associatedArns(tenant.tenantName);
      expect(arns).toContain(second.configurationSetArn);
      // A replacement must DROP the old link, not leave both associated.
      expect(arns).not.toContain(first.configurationSetArn);

      // Drop the association in its own step before tearing the stack down.
      // The replacement leaves both configuration sets `noop`, and a `noop`
      // resource never re-persists its downstream edges, so destroy orders
      // against the PRE-replacement target: `ConfigB` and `Link` delete
      // concurrently and SES rejects the configuration-set delete with "Cannot
      // delete <arn> because it has tenant associations". Removing the
      // association first keeps this test about replacement rather than about
      // that bug — see #979.
      yield* stack.deploy(
        Effect.gen(function* () {
          // Same logical id as the deploys above — renaming it here would
          // replace the tenant instead of only dropping the association.
          yield* Tenant("Customer", {});
          yield* ConfigurationSet("ConfigA", {});
          yield* ConfigurationSet("ConfigB", {});
        }),
      );

      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
