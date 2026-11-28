// @effect-diagnostics nodeBuiltinImport:off - Node supplies scrypt and constant-time comparison for the PIN verifier.
import * as NodeCrypto from "node:crypto";
import {
  LocalVaultName,
  VaultAccessMode,
  type VaultAccessMode as AccessMode,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ServerSecretStore, SecretStoreError } from "../auth/ServerSecretStore.ts";

const key = "vault-access-policy-v1";
const mutex = Semaphore.makeUnsafe(1);
export const newVaultEpoch = () => NodeCrypto.randomBytes(16).toString("hex");
const Policy = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    epoch: Schema.String,
    salt: Schema.String,
    hash: Schema.String,
    failures: Schema.Number,
    nextAttempt: Schema.Number,
    rules: Schema.Record(LocalVaultName, VaultAccessMode),
  }),
);
type Policy = typeof Policy.Type;
const decode = Schema.decodeUnknownEffect(Policy),
  encode = Schema.encodeEffect(Policy);
const messages = {
  pin_not_set: "Set a vault PIN in Settings → Secrets before using saved credentials.",
  pin_required: "Enter your vault PIN to approve this operation.",
  pin_invalid: "Incorrect vault PIN. Try again.",
  pin_locked: "Too many PIN attempts. Wait until the cooldown ends.",
  pin_format: "Use a PIN with 6 to 8 digits.",
  pin_weak: "Choose a less predictable PIN. Avoid repeated or sequential digits.",
  owner_required: "Set the first vault PIN from the owner's local Hyakki desktop.",
  unavailable: "The vault access policy is unavailable. Unlock the OS keyring and retry.",
  disclosure_required: "Explicitly allow command access before sharing real fields with an agent.",
} as const;
export class VaultAccessError extends Schema.TaggedError<VaultAccessError>()("VaultAccessError", {
  code: Schema.Literals(
    Object.keys(messages) as [keyof typeof messages, ...Array<keyof typeof messages>],
  ),
}) {
  override get message() {
    return messages[this.code];
  }
}
export const isVaultAccessError = Schema.is(VaultAccessError);
const read = Effect.fn("VaultAccess.read")(function* (
  store: ServerSecretStore["Service"] | undefined,
) {
  if (!store || store.storageMode !== "linux-keyring-aes256gcm")
    return yield* new VaultAccessError({ code: "unavailable" });
  const bytes = yield* store
    .get(key)
    .pipe(Effect.mapError(() => new VaultAccessError({ code: "unavailable" })));
  if (Option.isNone(bytes)) return undefined;
  try {
    const policy = yield* decode(new TextDecoder().decode(bytes.value)).pipe(
      Effect.mapError(() => new VaultAccessError({ code: "unavailable" })),
    );
    if (
      !/^[a-f0-9]{32}$/.test(policy.epoch) ||
      !/^[a-f0-9]{32}$/.test(policy.salt) ||
      !/^[a-f0-9]{64}$/.test(policy.hash) ||
      !Number.isSafeInteger(policy.failures) ||
      policy.failures < 0 ||
      !Number.isSafeInteger(policy.nextAttempt) ||
      policy.nextAttempt < 0
    )
      return yield* new VaultAccessError({ code: "unavailable" });
    return policy;
  } finally {
    bytes.value.fill(0);
  }
});
const write = Effect.fn("VaultAccess.write")(
  function* (store: ServerSecretStore["Service"], policy: Policy) {
    const raw = yield* encode(policy);
    const bytes = new TextEncoder().encode(raw);
    try {
      yield* store.set(key, bytes);
    } finally {
      bytes.fill(0);
    }
  },
  Effect.mapError(() => new VaultAccessError({ code: "unavailable" })),
);
function derive(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    NodeCrypto.scrypt(
      pin,
      Buffer.from(salt, "hex"),
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    ),
  );
}
const check = Effect.fn("VaultAccess.check")(function* (
  store: ServerSecretStore["Service"],
  policy: Policy,
  pin: Redacted.Redacted<string> | undefined,
) {
  if (!pin) return yield* new VaultAccessError({ code: "pin_required" });
  const now = yield* Clock.currentTimeMillis;
  if (now < policy.nextAttempt) return yield* new VaultAccessError({ code: "pin_locked" });
  const attempted = {
    ...policy,
    failures: Math.min(policy.failures + 1, 100),
    nextAttempt:
      policy.failures + 1 >= 5
        ? now + Math.min(3600000, 60000 * 2 ** Math.min(policy.failures - 4, 6))
        : 0,
  };
  yield* write(store, attempted);
  const raw = Redacted.value(pin);
  if (!/^[0-9]{6,8}$/.test(raw)) return yield* new VaultAccessError({ code: "pin_invalid" });
  const hash = yield* Effect.tryPromise({
    try: () => derive(raw, policy.salt),
    catch: () => new VaultAccessError({ code: "unavailable" }),
  });
  try {
    if (!NodeCrypto.timingSafeEqual(hash, Buffer.from(policy.hash, "hex")))
      return yield* new VaultAccessError({ code: "pin_invalid" });
  } finally {
    hash.fill(0);
  }
  const reset = { ...policy, failures: 0, nextAttempt: 0 };
  yield* write(store, reset);
  return reset;
});
export const vaultSecuritySummary = Effect.fn("VaultAccess.summary")(function* (
  store: ServerSecretStore["Service"] | undefined,
) {
  const policy = yield* read(store);
  const now = yield* Clock.currentTimeMillis;
  return {
    configured: policy !== undefined,
    retryAt: policy && policy.nextAttempt > now ? policy.nextAttempt : 0,
    rules: policy?.rules ?? {},
    epoch: policy?.epoch,
  };
});
export const setVaultPin = Effect.fn("VaultAccess.setPin")(function* (
  store: ServerSecretStore["Service"] | undefined,
  newPin: Redacted.Redacted<string>,
  oldPin: Redacted.Redacted<string> | undefined,
  canSetInitialPin: boolean,
) {
  try {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const policy = yield* read(store);
        if (!policy && !canSetInitialPin)
          return yield* new VaultAccessError({ code: "owner_required" });
        const checked = policy ? yield* check(store!, policy, oldPin) : undefined;
        const raw = Redacted.value(newPin);
        if (!/^[0-9]{6,8}$/.test(raw)) return yield* new VaultAccessError({ code: "pin_format" });
        if (/^([0-9])\1+$/.test(raw) || "0123456789".includes(raw) || "9876543210".includes(raw))
          return yield* new VaultAccessError({ code: "pin_weak" });
        const salt = NodeCrypto.randomBytes(16).toString("hex");
        const hash = yield* Effect.tryPromise({
          try: () => derive(raw, salt),
          catch: () => new VaultAccessError({ code: "unavailable" }),
        });
        try {
          if (!policy && store?.directory) {
            const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
            if (Option.isNone(fs)) return yield* new VaultAccessError({ code: "unavailable" });
            const files = yield* fs.value
              .readDirectory(store.directory)
              .pipe(Effect.mapError(() => new VaultAccessError({ code: "unavailable" })));
            for (const file of files)
              if (/^secret-request-[a-f0-9]{32}\.bin$/.test(file))
                yield* store
                  .remove(file.slice(0, -4))
                  .pipe(Effect.mapError(() => new VaultAccessError({ code: "unavailable" })));
          }
          yield* write(store!, {
            version: 1,
            epoch: newVaultEpoch(),
            salt,
            hash: hash.toString("hex"),
            failures: 0,
            nextAttempt: 0,
            rules: checked?.rules ?? {},
          });
        } finally {
          hash.fill(0);
        }
      }),
    );
  } finally {
    Redacted.wipeUnsafe(newPin);
    if (oldPin) Redacted.wipeUnsafe(oldPin);
  }
});
export const withVaultEdit = Effect.fn("VaultAccess.edit")(function* (
  store: ServerSecretStore["Service"],
  pin: Redacted.Redacted<string> | undefined,
  name: string,
  access: AccessMode | undefined,
  action: Effect.Effect<void, SecretStoreError>,
) {
  try {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const policy = yield* read(store);
        if (!policy) return yield* new VaultAccessError({ code: "pin_not_set" });
        const verified = yield* check(store, policy, pin);
        const revoked = { ...verified, epoch: newVaultEpoch() };
        yield* write(store, revoked);
        yield* action;
        const rules = { ...verified.rules };
        if (access === undefined) delete rules[name];
        else rules[name] = access;
        yield* write(store, { ...revoked, rules });
      }),
    );
  } finally {
    if (pin) Redacted.wipeUnsafe(pin);
  }
});
export const authorizeVaultUse = Effect.fn("VaultAccess.use")(function* (
  store: ServerSecretStore["Service"] | undefined,
  name: string,
  purpose: "provider" | "request" | "command" | "tagged",
  pin?: Redacted.Redacted<string>,
) {
  try {
    return yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const policy = yield* read(store);
        if (!policy) return yield* new VaultAccessError({ code: "pin_not_set" });
        const mode = Object.hasOwn(policy.rules, name) ? policy.rules[name] : "ask";
        if ((purpose === "provider" || purpose === "request") && mode === "allow")
          return policy.epoch;
        yield* check(store!, policy, pin);
        return policy.epoch;
      }),
    );
  } finally {
    if (pin) Redacted.wipeUnsafe(pin);
  }
});
