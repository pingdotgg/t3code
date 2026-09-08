import * as AWS from "@/AWS";
import {
  ManagedLoginBranding,
  UserPool,
  UserPoolClient,
  UserPoolDomain,
} from "@/AWS/Cognito";
import * as Test from "@/Test/Alchemy";
import * as cip from "@distilled.cloud/aws/cognito-identity-provider";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class BrandingStillExists extends Data.TaggedError("BrandingStillExists")<{
  readonly managedLoginBrandingId: string;
}> {}

const assertBrandingDeleted = (
  userPoolId: string,
  managedLoginBrandingId: string,
) =>
  cip
    .describeManagedLoginBranding({
      UserPoolId: userPoolId,
      ManagedLoginBrandingId: managedLoginBrandingId,
    })
    .pipe(
      Effect.flatMap(() =>
        Effect.fail(new BrandingStillExists({ managedLoginBrandingId })),
      ),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "BrandingStillExists",
        schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
      }),
    );

test.provider(
  "default branding activates managed login; update to custom settings; replace on client change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const infra = (
        useSecondClient: boolean,
        settings?: Record<string, unknown>,
      ) =>
        Effect.gen(function* () {
          const pool = yield* UserPool("BrandingPool", {});
          const clientA = yield* UserPoolClient("WebA", {
            userPoolId: pool.userPoolId,
          });
          const clientB = yield* UserPoolClient("WebB", {
            userPoolId: pool.userPoolId,
          });
          const domain = yield* UserPoolDomain("AuthDomain", {
            userPoolId: pool.userPoolId,
            managedLoginVersion: 2,
          });
          const branding = yield* ManagedLoginBranding("Branding", {
            userPoolId: pool.userPoolId,
            clientId: useSecondClient ? clientB.clientId : clientA.clientId,
            ...(settings === undefined ? {} : { settings }),
          });
          return { pool, clientA, clientB, domain, branding };
        });

      const created = yield* stack.deploy(infra(false));

      expect(created.branding.managedLoginBrandingId).toBeDefined();
      expect(created.branding.userPoolId).toBe(created.pool.userPoolId);
      expect(created.branding.clientId).toBe(created.clientA.clientId);
      expect(created.domain.domain).toBeDefined();

      // out-of-band: the client has the style assigned with Cognito's
      // provided default values (no console step required)
      const byClient = yield* cip.describeManagedLoginBrandingByClient({
        UserPoolId: created.pool.userPoolId,
        ClientId: created.clientA.clientId,
      });
      expect(byClient.ManagedLoginBranding?.ManagedLoginBrandingId).toBe(
        created.branding.managedLoginBrandingId,
      );
      expect(byClient.ManagedLoginBranding?.UseCognitoProvidedValues).toBe(
        true,
      );

      // update in place: switch from provided values to custom settings
      // (use the merged provided-values document, the exact designer shape)
      const merged = yield* cip.describeManagedLoginBranding({
        UserPoolId: created.pool.userPoolId,
        ManagedLoginBrandingId: created.branding.managedLoginBrandingId,
        ReturnMergedResources: true,
      });
      const settings = merged.ManagedLoginBranding?.Settings as Record<
        string,
        unknown
      >;
      expect(settings).toBeDefined();

      const updated = yield* stack.deploy(infra(false, settings));
      expect(updated.branding.managedLoginBrandingId).toBe(
        created.branding.managedLoginBrandingId,
      );
      const afterUpdate = yield* cip.describeManagedLoginBranding({
        UserPoolId: created.pool.userPoolId,
        ManagedLoginBrandingId: created.branding.managedLoginBrandingId,
      });
      expect(afterUpdate.ManagedLoginBranding?.UseCognitoProvidedValues).toBe(
        false,
      );

      // changing the app client replaces the branding style
      const replaced = yield* stack.deploy(infra(true, settings));
      expect(replaced.branding.managedLoginBrandingId).not.toBe(
        created.branding.managedLoginBrandingId,
      );
      expect(replaced.branding.clientId).toBe(created.clientB.clientId);
      yield* assertBrandingDeleted(
        created.pool.userPoolId,
        created.branding.managedLoginBrandingId,
      );
      const replacedByClient = yield* cip.describeManagedLoginBrandingByClient({
        UserPoolId: created.pool.userPoolId,
        ClientId: created.clientB.clientId,
      });
      expect(
        replacedByClient.ManagedLoginBranding?.ManagedLoginBrandingId,
      ).toBe(replaced.branding.managedLoginBrandingId);

      yield* stack.destroy();
      yield* cip.describeUserPool({ UserPoolId: created.pool.userPoolId }).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new BrandingStillExists({
              managedLoginBrandingId: created.pool.userPoolId,
            }),
          ),
        ),
        Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        Effect.retry({
          while: (e) => e._tag === "BrandingStillExists",
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
    }),
  { timeout: 180_000 },
);
