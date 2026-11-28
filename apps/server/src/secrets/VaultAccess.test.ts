import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { ServerSecretStore, SecretStorePersistError } from "../auth/ServerSecretStore.ts";
import {
  authorizeVaultUse,
  setVaultPin,
  vaultSecuritySummary,
  withVaultEdit,
} from "./VaultAccess.ts";
const PIN = "8472951",
  NEXT = "65928741";
function fixture() {
  const values = new Map<string, Uint8Array>();
  const store = ServerSecretStore.of({
    storageMode: "linux-keyring-aes256gcm",
    get: (key) => Effect.sync(() => Option.fromNullishOr(values.get(key)?.slice())),
    set: (key, value) =>
      Effect.sync(() => {
        values.set(key, value.slice());
      }),
    create: () => Effect.die("unused"),
    remove: () => Effect.die("unused"),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  return { store, values };
}
const setup = (store: ServerSecretStore["Service"]) =>
  setVaultPin(store, Redacted.make(PIN), undefined, true);
it.effect(
  "requires a trusted owner bootstrap for first setup and never stores a plaintext PIN",
  () =>
    Effect.gen(function* () {
      const { store, values } = fixture();
      assert.equal(
        (yield* authorizeVaultUse(store, "entry", "request").pipe(Effect.flip)).code,
        "pin_not_set",
      );
      assert.equal(
        (yield* setVaultPin(store, Redacted.make(PIN), undefined, false).pipe(Effect.flip)).code,
        "owner_required",
      );
      assert.isFalse((yield* vaultSecuritySummary(store)).configured);
      for (const pin of ["12345", "123456789", "１２３４５６", "abcdef"]) {
        assert.equal(
          (yield* setVaultPin(store, Redacted.make(pin), undefined, true).pipe(Effect.flip)).code,
          "pin_format",
        );
      }
      for (const pin of ["000000", "1111111", "123456", "87654321"]) {
        assert.equal(
          (yield* setVaultPin(store, Redacted.make(pin), undefined, true).pipe(Effect.flip)).code,
          "pin_weak",
        );
      }
      yield* setup(store);
      const policy = new TextDecoder().decode(values.get("vault-access-policy-v1")!);
      assert.notInclude(policy, `"${PIN}"`);
      assert.notInclude(policy, '"pin"');
      assert.deepInclude(yield* vaultSecuritySummary(store), { configured: true, retryAt: 0 });
      assert.equal(
        (yield* setVaultPin(store, Redacted.make(NEXT), undefined, true).pipe(Effect.flip)).code,
        "pin_required",
      );
    }),
);
it.effect("asks by default and never executes a write without the correct PIN", () =>
  Effect.gen(function* () {
    const { store } = fixture();
    yield* setup(store);
    let writes = 0;
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "provider").pipe(Effect.flip)).code,
      "pin_required",
    );
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "request").pipe(Effect.flip)).code,
      "pin_required",
    );
    const action = Effect.sync(() => {
      writes++;
    });
    assert.propertyVal(
      yield* withVaultEdit(store, undefined, "entry", "allow", action).pipe(Effect.flip),
      "code",
      "pin_required",
    );
    assert.propertyVal(
      yield* withVaultEdit(store, Redacted.make("111111"), "entry", "allow", action).pipe(
        Effect.flip,
      ),
      "code",
      "pin_invalid",
    );
    assert.equal(writes, 0);
    const grant = yield* authorizeVaultUse(store, "entry", "request", Redacted.make(PIN));
    assert.isString(grant);
    yield* withVaultEdit(store, Redacted.make(PIN), "entry", "allow", action);
    assert.equal(writes, 1);
    assert.isString(yield* authorizeVaultUse(store, "entry", "provider"));
    assert.isString(yield* authorizeVaultUse(store, "entry", "request"));
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "tagged").pipe(Effect.flip)).code,
      "pin_required",
    );
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "command").pipe(Effect.flip)).code,
      "pin_required",
    );
    yield* authorizeVaultUse(store, "entry", "command", Redacted.make(PIN));
    assert.notEqual((yield* vaultSecuritySummary(store)).epoch, grant);
  }),
);
it.effect(
  "persists failed attempts across callers and enforces cooldown even for the correct PIN",
  () =>
    Effect.gen(function* () {
      const { store } = fixture();
      yield* setup(store);
      for (let n = 0; n < 5; n++)
        assert.equal(
          (yield* authorizeVaultUse(store, "entry", "request", Redacted.make("000000")).pipe(
            Effect.flip,
          )).code,
          "pin_invalid",
        );
      const persisted = yield* vaultSecuritySummary({ ...store });
      assert.isAbove(persisted.retryAt, 0);
      assert.equal(
        (yield* authorizeVaultUse({ ...store }, "entry", "request", Redacted.make(PIN)).pipe(
          Effect.flip,
        )).code,
        "pin_locked",
      );
      yield* TestClock.adjust("1 minute");
      yield* authorizeVaultUse(store, "entry", "request", Redacted.make(PIN));
      assert.equal((yield* vaultSecuritySummary(store)).retryAt, 0);
    }),
);
it.effect("changes the PIN only after checking the old one and invalidates earlier approvals", () =>
  Effect.gen(function* () {
    const { store } = fixture();
    yield* setup(store);
    const prior = yield* authorizeVaultUse(store, "entry", "request", Redacted.make(PIN));
    assert.equal(
      (yield* setVaultPin(store, Redacted.make(NEXT), Redacted.make("111111"), true).pipe(
        Effect.flip,
      )).code,
      "pin_invalid",
    );
    yield* setVaultPin(store, Redacted.make(NEXT), Redacted.make(PIN), false);
    assert.notEqual((yield* vaultSecuritySummary(store)).epoch, prior);
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "request", Redacted.make(PIN)).pipe(Effect.flip))
        .code,
      "pin_invalid",
    );
    yield* authorizeVaultUse(store, "entry", "request", Redacted.make(NEXT));
  }),
);
it.effect("fails closed for corrupt policies and does not reset them through setup", () =>
  Effect.gen(function* () {
    const { store, values } = fixture();
    values.set("vault-access-policy-v1", new TextEncoder().encode("broken"));
    assert.equal((yield* vaultSecuritySummary(store).pipe(Effect.flip)).code, "unavailable");
    assert.equal((yield* setup(store).pipe(Effect.flip)).code, "unavailable");
    assert.equal(
      (yield* authorizeVaultUse(store, "entry", "provider").pipe(Effect.flip)).code,
      "unavailable",
    );
    assert.equal(new TextDecoder().decode(values.get("vault-access-policy-v1")!), "broken");
  }),
);
it.effect("first setup revokes pending legacy approvals without removing the request salt", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const { store } = fixture();
    const name = `secret-request-${"a".repeat(32)}`;
    yield* fs.writeFileString(`${directory}/${name}.bin`, "dummy pending approval");
    yield* fs.writeFileString(`${directory}/secret-request-salt.bin`, "dummy salt");
    yield* setup({
      ...store,
      directory,
      remove: (key) =>
        fs
          .remove(`${directory}/${key}.bin`)
          .pipe(
            Effect.mapError(
              (cause) => new SecretStorePersistError({ resource: "test approval", cause }),
            ),
          ),
    });
    assert.isFalse(yield* fs.exists(`${directory}/${name}.bin`));
    assert.isTrue(yield* fs.exists(`${directory}/secret-request-salt.bin`));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect(
  "a failed final policy commit cannot leave an allow grant or a stale approval valid",
  () =>
    Effect.gen(function* () {
      const { store } = fixture();
      yield* setup(store);
      const prior = yield* vaultSecuritySummary(store);
      let calls = 0,
        ran = false;
      const failing = {
        ...store,
        set: (key: string, value: Uint8Array) =>
          ++calls === 4
            ? Effect.fail(
                new SecretStorePersistError({
                  resource: "test policy",
                  cause: new Error("denied"),
                }),
              )
            : store.set(key, value),
      };
      yield* withVaultEdit(
        failing,
        Redacted.make(PIN),
        "entry",
        "allow",
        Effect.sync(() => {
          ran = true;
        }),
      ).pipe(Effect.flip);
      assert.isTrue(ran);
      assert.deepStrictEqual((yield* vaultSecuritySummary(store)).rules, {});
      assert.notEqual((yield* vaultSecuritySummary(store)).epoch, prior.epoch);
      assert.equal(
        (yield* authorizeVaultUse(store, "entry", "provider").pipe(Effect.flip)).code,
        "pin_required",
      );
    }),
);
it.effect("does not grant allow access when a credential write fails", () =>
  Effect.gen(function* () {
    const { store } = fixture();
    yield* setup(store);
    const previous = yield* vaultSecuritySummary(store);
    const failed = Effect.fail(
      new SecretStorePersistError({ resource: "test entry", cause: new Error("denied") }),
    );
    yield* withVaultEdit(store, Redacted.make(PIN), "entry", "allow", failed).pipe(Effect.flip);
    assert.deepStrictEqual((yield* vaultSecuritySummary(store)).rules, {});
    assert.notEqual((yield* vaultSecuritySummary(store)).epoch, previous.epoch);
  }),
);
