import * as AWS from "@/AWS";
import { IdentitySource, PolicyStore } from "@/AWS/VerifiedPermissions";
import * as Test from "@/Test/Alchemy";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const unwrap = (v: string | Redacted.Redacted<string> | undefined) =>
  v === undefined ? undefined : Redacted.isRedacted(v) ? Redacted.value(v) : v;

const { test } = Test.make({ providers: AWS.providers() });

const findSource = (policyStoreId: string, identitySourceId: string) =>
  avp
    .getIdentitySource({ policyStoreId, identitySourceId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "identity source lifecycle: create OIDC source, update client ids, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (clientIds: string[]) =>
        Effect.gen(function* () {
          const store = yield* PolicyStore("Store", {
            validationMode: "OFF",
          });
          const source = yield* IdentitySource("Oidc", {
            policyStoreId: store.policyStoreId,
            principalEntityType: "PhotoApp::User",
            openIdConnect: {
              // AVP fetches /.well-known/openid-configuration at create time,
              // so the issuer must be a live OIDC discovery endpoint
              issuer: "https://accounts.google.com",
              tokenSelection: {
                identityTokenOnly: { clientIds },
              },
            },
          });
          return { store, source };
        });

      // create
      const { store, source } = yield* stack.deploy(
        makeStack(["alchemy-test-client"]),
      );
      expect(source.identitySourceId).toBeDefined();
      expect(source.policyStoreId).toBe(store.policyStoreId);

      // out-of-band verify
      const created = yield* findSource(
        store.policyStoreId,
        source.identitySourceId,
      );
      expect(unwrap(created?.principalEntityType)).toBe("PhotoApp::User");
      expect(created?.configuration?.openIdConnectConfiguration?.issuer).toBe(
        "https://accounts.google.com",
      );

      // update client ids in place (identitySourceId is stable)
      const updated = yield* stack.deploy(
        makeStack(["alchemy-test-client", "second-client"]),
      );
      expect(updated.source.identitySourceId).toBe(source.identitySourceId);

      const afterUpdate = yield* findSource(
        store.policyStoreId,
        source.identitySourceId,
      );
      const tokenSelection =
        afterUpdate?.configuration?.openIdConnectConfiguration?.tokenSelection;
      const observedClientIds = (
        tokenSelection?.identityTokenOnly?.clientIds ?? []
      ).map((id) => unwrap(id)!);
      expect([...observedClientIds].sort()).toEqual([
        "alchemy-test-client",
        "second-client",
      ]);

      // destroy
      yield* stack.destroy();
      const gone = yield* findSource(
        store.policyStoreId,
        source.identitySourceId,
      );
      expect(gone).toBeUndefined();
    }),
  { timeout: 180_000 },
);
