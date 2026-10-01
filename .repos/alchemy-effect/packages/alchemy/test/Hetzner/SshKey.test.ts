import { generateKeyPairSync } from "node:crypto";
import * as Hetzner from "@/Hetzner";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { Services } from "@distilled.cloud/hetzner";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Hetzner.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasHetznerCreds = !!process.env.HCLOUD_TOKEN;

const generatePublicKey = (comment: string) =>
  Effect.sync(() => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const der = publicKey.export({ type: "spki", format: "der" });
    const raw = der.subarray(der.length - 32);
    const type = Buffer.from("ssh-ed25519");
    const u32 = (n: number) => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(n);
      return buf;
    };
    const payload = Buffer.concat([
      u32(type.length),
      type,
      u32(raw.length),
      raw,
    ]);
    return `ssh-ed25519 ${payload.toString("base64")} ${comment}`;
  });

const waitUntilGone = (id: number) =>
  Services.sshKeys.getSshKey({ id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasHetznerCreds)(
  "create, update, and delete an ssh key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const publicKey = yield* generatePublicKey("alchemy-sshkey-crud");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.SshKey("DeployKey", {
            publicKey,
            labels: { env: "test" },
          });
        }),
      );

      expect(created.id).toEqual(expect.any(Number));
      expect(created.name).toEqual(expect.any(String));
      expect(created.fingerprint).toEqual(expect.any(String));
      expect(created.publicKey).toContain("ssh-ed25519");
      expect(created.created).toEqual(expect.any(String));
      expect(created.labels).toMatchObject({ env: "test" });

      const fetched = yield* Services.sshKeys.getSshKey({ id: created.id });
      expect(fetched.ssh_key.id).toEqual(created.id);
      expect(fetched.ssh_key.name).toEqual(created.name);
      expect(fetched.ssh_key.fingerprint).toEqual(created.fingerprint);
      expect(fetched.ssh_key.labels.env).toEqual("test");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.SshKey("DeployKey", {
            name: `${created.name.slice(0, 55)}-renamed`,
            publicKey,
            labels: { env: "prod", role: "deploy" },
          });
        }),
      );

      expect(updated.id).toEqual(created.id);
      expect(updated.fingerprint).toEqual(created.fingerprint);
      expect(updated.name).toEqual(`${created.name.slice(0, 55)}-renamed`);
      expect(updated.labels).toMatchObject({ env: "prod", role: "deploy" });

      const refetched = yield* Services.sshKeys.getSshKey({ id: updated.id });
      expect(refetched.ssh_key.name).toEqual(updated.name);
      expect(refetched.ssh_key.labels.env).toEqual("prod");
      expect(refetched.ssh_key.labels.role).toEqual("deploy");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "replace when public key changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const firstKey = yield* generatePublicKey("alchemy-sshkey-replace-a");
      const secondKey = yield* generatePublicKey("alchemy-sshkey-replace-b");

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.SshKey("ReplaceKey", {
            publicKey: firstKey,
          });
        }),
      );

      expect(created.publicKey).toContain("ssh-ed25519");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.SshKey("ReplaceKey", {
            name: created.name,
            publicKey: secondKey,
          });
        }),
      );

      expect(replaced.id).not.toEqual(created.id);
      expect(replaced.fingerprint).not.toEqual(created.fingerprint);
      expect(replaced.name).toEqual(created.name);

      const fetched = yield* Services.sshKeys.getSshKey({ id: replaced.id });
      expect(fetched.ssh_key.id).toEqual(replaced.id);
      expect(fetched.ssh_key.fingerprint).toEqual(replaced.fingerprint);

      const oldGone = yield* waitUntilGone(created.id);
      expect(oldGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 180_000 },
);

test.provider.skipIf(!hasHetznerCreds)(
  "list enumerates the deployed ssh key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const publicKey = yield* generatePublicKey("alchemy-sshkey-list");

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Hetzner.SshKey("ListKey", { publicKey });
        }),
      );

      const provider = yield* Provider.findProvider(Hetzner.SshKey);
      const all = yield* provider.list();
      const found = all.find((key) => key.id === deployed.id);
      expect(found).toBeDefined();
      expect(found?.name).toEqual(deployed.name);
      expect(found?.fingerprint).toEqual(deployed.fingerprint);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(deployed.id);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 120_000 },
);
