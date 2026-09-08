import { createHash } from "node:crypto";
import { Services } from "@distilled.cloud/hetzner";
import type { GetSshKeyResponseSshKey } from "@distilled.cloud/hetzner/ssh_keys";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { tagRecord } from "../Tags.ts";
import {
  alchemyLabelKeys,
  alchemyStackSelector,
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "./Labels.ts";
import type { Providers } from "./Providers.ts";

export type SshKeyProps = {
  /**
   * Name of the SSH key. Must be unique per Hetzner project. If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   */
  name?: string;
  /**
   * OpenSSH-format public key. Changing it replaces the SSH key.
   */
  publicKey: string;
  /**
   * User-defined labels (`key/value` pairs). Alchemy ownership labels are
   * merged in automatically.
   */
  labels?: Record<string, string>;
};

export type SshKey = Resource<
  "Hetzner.SshKey",
  SshKeyProps,
  {
    /** Numeric Hetzner SSH key id. */
    id: number;
    /** Name of the SSH key (unique per project). */
    name: string;
    /** MD5 fingerprint of the public key (`aa:bb:…`). */
    fingerprint: string;
    /** Public key as stored by Hetzner. */
    publicKey: string;
    /** User-defined labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    created: string;
  },
  never,
  Providers
>;

/**
 * A Hetzner Cloud SSH key. Public keys are injected into Servers at create
 * time. The public key is immutable — changing it replaces the key.
 *
 * @see https://docs.hetzner.cloud/reference/cloud#ssh-keys
 *
 * ### Creating an SSH Key
 * **Example:** Generated name
 * ```typescript
 * const key = yield* Hetzner.SshKey("deploy", {
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… user@host",
 * });
 * ```
 *
 * **Example:** Explicit name and labels
 * ```typescript
 * const key = yield* Hetzner.SshKey("deploy", {
 *   name: "deploy-key",
 *   publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI… user@host",
 *   labels: { role: "deploy" },
 * });
 * ```
 *
 * @resource
 */
export const SshKey = Resource<SshKey>("Hetzner.SshKey");

export class SshKeyNotResolved extends Data.TaggedError(
  "Hetzner.SshKeyNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    return (
      name ?? existing ?? (yield* createPhysicalName({ id, maxLength: 64 }))
    );
  });

const toAttrs = (key: GetSshKeyResponseSshKey) => ({
  id: key.id,
  name: key.name,
  fingerprint: key.fingerprint,
  publicKey: key.public_key,
  labels: userLabels(key.labels),
  created: key.created,
});

const fingerprintOf = (publicKey: string) =>
  Effect.sync(() => {
    const b64 = publicKey.trim().split(/\s+/)[1];
    if (b64 === undefined) return undefined;
    const hex = createHash("md5")
      .update(Buffer.from(b64, "base64"))
      .digest("hex");
    return hex.match(/.{2}/g)?.join(":");
  });

const getById = (id: number) =>
  Services.sshKeys.getSshKey({ id }).pipe(
    Effect.map(({ ssh_key }) => ssh_key),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const findByName = (name: string) =>
  Services.sshKeys
    .listSshKeys({ name, per_page: 50 })
    .pipe(
      Effect.map(({ ssh_keys }) => ssh_keys.find((key) => key.name === name)),
    );

const findByFingerprint = (fingerprint: string) =>
  Services.sshKeys
    .listSshKeys({ fingerprint, per_page: 50 })
    .pipe(Effect.map(({ ssh_keys }) => ssh_keys[0]));

const observe = Effect.fn(function* (input: {
  id?: number;
  name: string;
  publicKey: string;
}) {
  if (input.id !== undefined) {
    const byId = yield* getById(input.id);
    if (byId !== undefined) return byId;
  }
  const byName = yield* findByName(input.name);
  if (byName !== undefined) return byName;
  const fingerprint = yield* fingerprintOf(input.publicKey);
  if (fingerprint === undefined) return undefined;
  return yield* findByFingerprint(fingerprint);
});

export const SshKeyProvider = () =>
  Provider.succeed(SshKey, {
    stables: ["id", "fingerprint", "publicKey", "created"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.publicKey ?? output?.publicKey;
      if (previous !== undefined && news.publicKey.trim() !== previous.trim()) {
        const previousName = olds?.name ?? output?.name;
        const nextName = news.name ?? previousName;
        return {
          action: "replace" as const,
          deleteFirst: nextName !== undefined && nextName === previousName,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const name = yield* toName(id, olds?.name, output?.name);
      const publicKey = olds?.publicKey ?? output?.publicKey ?? "";
      const existing = yield* observe({
        id: output?.id,
        name,
        publicKey,
      });
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Services.sshKeys.listSshKeys
        .items({ label_selector: alchemyStackSelector, per_page: 50 })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk, toAttrs)),
        ),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* toName(id, news.name, output?.name);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* observe({
        id: output?.id,
        name,
        publicKey: news.publicKey,
      });

      if (current === undefined) {
        const created = yield* Services.sshKeys
          .createSshKey({
            name,
            public_key: news.publicKey,
            labels: desiredLabels,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created?.ssh_key ??
          (yield* observe({
            id: output?.id,
            name,
            publicKey: news.publicKey,
          }));
      }

      if (current === undefined) {
        return yield* new SshKeyNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const nameChanged = current.name !== name;
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      if (nameChanged || labelsChanged) {
        const updated = yield* Services.sshKeys.updateSshKey({
          id: current.id,
          name: nameChanged ? name : undefined,
          labels: labelsChanged ? desiredLabels : undefined,
        });
        current = updated.ssh_key;
      }

      return toAttrs(current);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Services.sshKeys
        .deleteSshKey({ id: output.id })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
