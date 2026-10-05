import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as oslogin from "@distilled.cloud/gcp/oslogin_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const KEY1 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN6Ot81wrURgF58/jKCFQgEzJFjD39ibwfpeC7JLoS6d";
const KEY2 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBpVICT7tXAjpo6pXw/44Wm+DYcQRexT7J8nwS9/XtnL";

const EXPIRY_A = "4102444800000000";
const EXPIRY_B = "4133980800000000";

// OS Login keys belong to the authenticated account. A service account
// must name itself (`users/me` fails with UserCredentialMismatch), so set
// GCP_TEST_OSLOGIN_USER to the test credentials' email.
const user = process.env.GCP_TEST_OSLOGIN_USER?.trim();

const waitUntilGone = (name: string) =>
  oslogin.getUsersSshPublicKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "users/me with service-account credentials fails with UserCredentialMismatch",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        oslogin.getUsersSshPublicKeys({
          name: "users/me/sshPublicKeys/alchemy-missing-fingerprint",
        }),
      );
      expect(error._tag).toEqual("UserCredentialMismatch");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:gcp", "provider:gcp:oslogin", "live"], timeout: 90_000 },
);

test.provider.skipIf(!user || !!process.env.FAST)(
  "create, update, and delete an SSH public key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
            user,
            key: KEY1,
            expirationTimeUsec: EXPIRY_A,
          });
        }),
      );

      expect(created.name.length).toBeGreaterThan(0);
      expect(created.fingerprint.length).toBeGreaterThan(0);
      expect(created.user).toEqual(user);
      expect(created.key).toEqual(KEY1);
      expect(created.expirationTimeUsec).toEqual(EXPIRY_A);

      const fetched = yield* oslogin.getUsersSshPublicKeys({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.fingerprint).toEqual(created.fingerprint);
      expect(fetched.key).toEqual(KEY1);
      expect(fetched.expirationTimeUsec).toEqual(EXPIRY_A);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
            user,
            key: KEY1,
            expirationTimeUsec: EXPIRY_B,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.fingerprint).toEqual(created.fingerprint);
      expect(updated.expirationTimeUsec).toEqual(EXPIRY_B);

      const fetchedUpdate = yield* oslogin.getUsersSshPublicKeys({
        name: updated.name,
      });
      expect(fetchedUpdate.expirationTimeUsec).toEqual(EXPIRY_B);
      expect(fetchedUpdate.key).toEqual(KEY1);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.OSLogin.UsersSshPublicKey("Laptop", {
            user,
            key: KEY2,
            expirationTimeUsec: EXPIRY_B,
          });
        }),
      );

      expect(replaced.fingerprint).not.toEqual(created.fingerprint);
      expect(replaced.key).toEqual(KEY2);

      const fetchedReplace = yield* oslogin.getUsersSshPublicKeys({
        name: replaced.name,
      });
      expect(fetchedReplace.fingerprint).toEqual(replaced.fingerprint);
      expect(fetchedReplace.key).toEqual(KEY2);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:gcp", "provider:gcp:oslogin", "live"],
    timeout: 90_000,
    exclusive: true,
  },
);
