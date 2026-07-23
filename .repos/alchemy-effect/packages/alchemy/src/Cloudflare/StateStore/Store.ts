import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import { pipe } from "effect/Function";
import type {
  ReplacedResourceState,
  ResourceState,
} from "../../State/ResourceState.ts";
import { encodeState } from "../../State/StateEncoding.ts";
import * as Secret from "../SecretsStore/Secret.ts";
import { DurableObjectNamespace } from "../Workers/DurableObjectNamespace.ts";
import { DurableObjectState } from "../Workers/DurableObjectState.ts";
import { EncryptionKey } from "./Token.ts";

export default class Store extends DurableObjectNamespace<Store>()(
  "Store",
  Effect.gen(function* () {
    // Outer (class-level) phase — resolve the binding factory once.
    // The actual secret read happens inside each DO instance below,
    // since `SecretClient.get()` needs the per-instance worker env.
    const encryptionSecret = yield* Secret.Secret.bind(EncryptionKey);

    return Effect.gen(function* () {
      // Inner (per-instance) phase — set up storage and the AES key.
      // The key is imported once per DO boot and reused thereafter.
      const doState = yield* DurableObjectState;
      const storage = doState.storage;

      const keyHex = yield* encryptionSecret
        .get()
        .pipe(Effect.map(Redacted.value), Effect.orDie);
      const cryptoKey = yield* Effect.tryPromise(() =>
        crypto.subtle.importKey(
          "raw",
          Buffer.from(keyHex, "hex"),
          { name: "AES-CTR" },
          false,
          ["encrypt", "decrypt"],
        ),
      ).pipe(Effect.orDie);

      const encryptValue = (value: unknown) =>
        Effect.tryPromise(async () => {
          const plaintext = new TextEncoder().encode(
            JSON.stringify(encodeState(value)),
          );
          const counter = crypto.getRandomValues(allocBytes(NONCE_BYTES));
          const ct = new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-CTR", counter, length: 64 },
              cryptoKey,
              plaintext,
            ),
          );
          // Frame as a single base64 string: nonce || ciphertext.
          return Buffer.concat([counter, ct]).toString("base64");
        }).pipe(Effect.orDie);

      const decryptEntry = (entry: string) =>
        Effect.tryPromise(async () => {
          const framed = Buffer.from(entry, "base64");
          const counter = framed.subarray(0, NONCE_BYTES);
          const ciphertext = framed.subarray(NONCE_BYTES);
          let pt;
          try {
            pt = await crypto.subtle.decrypt(
              { name: "AES-CTR", counter, length: 64 },
              cryptoKey,
              ciphertext,
            );
          } catch (error) {
            // We return undefined here because in 2.0.0-beta.45, we rotated encryption keys unnecessarily.
            // So, we catch a decryption error here and return undefined instead.
            // The engine should reconcile, hopefully, but users may lose some data
            console.error(
              "Error decrypting entry. Returning undefined instead.",
              error,
            );
            return undefined;
          }
          return JSON.parse(new TextDecoder().decode(pt)) as ResourceState;
        }).pipe(Effect.orDie);

      return {
        // -- Root DO methods -----------------------------------------

        /**
         * (Root DO only) List every stack name ever registered.
         */
        listStacks: Effect.fnUntraced(function* () {
          const entries = yield* storage.list<number>({
            prefix: STACK_INDEX_PREFIX,
          });
          const stacks: string[] = [];
          for (const key of entries.keys()) {
            stacks.push(key.slice(STACK_INDEX_PREFIX.length));
          }
          return stacks;
        }),

        /**
         * (Root DO only) Register a stack name. Idempotent — safe to
         * call on every `set` to the corresponding stack DO.
         */
        registerStack: ({ stack }: { stack: string }) =>
          storage.put(`${STACK_INDEX_PREFIX}${stack}`, 1),

        /**
         * (Root DO only) Remove a stack name from the global index.
         */
        unregisterStack: ({ stack }: { stack: string }) =>
          storage.delete(`${STACK_INDEX_PREFIX}${stack}`),

        // -- Stack DO methods ----------------------------------------

        /** (Stack DO only) List stages with at least one resource. */
        listStages: () =>
          storage
            .list<string>({
              prefix: RESOURCE_PREFIX,
            })
            .pipe(
              Effect.map((entries) => {
                const stages = new Set<string>();
                for (const key of entries.keys()) {
                  const parsed = parseResourceKey(key);
                  if (parsed) stages.add(parsed.stage);
                }
                return [...stages];
              }),
            ),

        /** (Stack DO only) List every resource FQN in a stage. */
        listResources: ({ stage }: { stage: string }) =>
          storage
            .list<string>({
              prefix: stagePrefix(stage),
            })
            .pipe(
              Effect.map((entries) => {
                const fqns: string[] = [];
                for (const key of entries.keys()) {
                  const parsed = parseResourceKey(key);
                  if (parsed) fqns.push(parsed.fqn);
                }
                return fqns;
              }),
            ),

        /**
         * (Stack DO only) Get a resource by (stage, fqn). Returns
         * null if missing.
         */
        get: ({ stage, fqn }: { stage: string; fqn: string }) =>
          storage
            .get<string>(resourceKey(stage, fqn))
            .pipe(
              Effect.flatMap((entry) =>
                entry == null ? Effect.succeed(undefined) : decryptEntry(entry),
              ),
            ),

        /**
         * (Stack DO only) Persist a resource. Returns the stored
         * value unchanged.
         */
        set: ({
          stage,
          fqn,
          value,
        }: {
          stage: string;
          fqn: string;
          value: ResourceState;
        }) =>
          encryptValue(value).pipe(
            Effect.flatMap((encrypted) =>
              storage
                .put<string>(resourceKey(stage, fqn), encrypted)
                .pipe(Effect.asVoid),
            ),
            Effect.map(() => value),
          ),

        /**
         * (Stack DO only) Delete a resource. Idempotent.
         *
         * Exposed as `remove` (not `delete`) because Cloudflare's
         * Durable Object RPC stub reserves `delete` and refuses to
         * proxy the call, surfacing as "RPC receiver does not
         * implement the method 'delete'".
         */
        remove: ({ stage, fqn }: { stage: string; fqn: string }) =>
          storage.delete(resourceKey(stage, fqn)),

        /**
         * (Stack DO only) Delete every resource in this stack, or every
         * resource in a single stage when specified.
         */
        deleteStack: ({ stage }: { stage?: string } = {}) =>
          stage === undefined
            ? storage.deleteAll()
            : storage.list<string>({ prefix: stagePrefix(stage) }).pipe(
                Effect.flatMap((entries) => {
                  const keys = [...entries.keys(), stackOutputKey(stage)];
                  return storage.delete(keys).pipe(Effect.asVoid);
                }),
              ),

        /**
         * (Stack DO only) Read the persisted stack output for `stage`.
         * Returns `undefined` when the stage has not been deployed.
         */
        getOutput: ({ stage }: { stage: string }) =>
          storage
            .get<string>(stackOutputKey(stage))
            .pipe(
              Effect.flatMap((entry) =>
                entry == null ? Effect.succeed(undefined) : decryptEntry(entry),
              ),
            ),

        /**
         * (Stack DO only) Persist the resolved stack output for
         * `stage`. Returns the stored value unchanged.
         */
        setOutput: ({ stage, value }: { stage: string; value: any }) =>
          encryptValue(value).pipe(
            Effect.flatMap((encrypted) =>
              storage
                .put<string>(stackOutputKey(stage), encrypted)
                .pipe(Effect.asVoid),
            ),
            Effect.map(() => value),
          ),

        /**
         * (Stack DO only) Return every resource in a stage whose
         * `status === "replaced"`. Each entry is decrypted so the
         * `status` field can be inspected.
         */
        getReplacedResources: ({ stage }: { stage: string }) =>
          pipe(
            storage.list<string>({ prefix: stagePrefix(stage) }),
            Effect.map((entries) =>
              [...entries.values()].filter((e): e is string => !!e),
            ),
            Effect.flatMap(
              Effect.forEach(decryptEntry, { concurrency: "unbounded" }),
            ),
            Effect.map((decoded) =>
              decoded.filter(
                (d): d is ReplacedResourceState => d?.status === "replaced",
              ),
            ),
          ),
      };
    });
  }),
) {
  /**
   * Well-known DO name whose sole job is to track the set of stacks
   * that have ever had resources written. `listStacks` queries it;
   * every `set` asks it to register the stack (idempotent).
   */
  static readonly ROOT_DO_NAME = "__root__" as const;
}

/** NUL byte separator for composite keys. */
const SEP = "\x00";

/** Key prefix for resource entries in a stack DO. */
const RESOURCE_PREFIX = `r${SEP}`;

/** Key prefix for stack-output entries in a stack DO. */
const STACK_OUTPUT_PREFIX = `o${SEP}`;

/** Key prefix for stack-index entries in the root DO. */
const STACK_INDEX_PREFIX = "s:";

/** AES-CTR counter block length. */
const NONCE_BYTES = 16;

/** Build the resource key inside a *stack DO*. */
const resourceKey = (stage: string, fqn: string) =>
  `${RESOURCE_PREFIX}${stage}${SEP}${fqn}`;

/** Prefix matching every resource key inside a specific stage. */
const stagePrefix = (stage: string) => `${RESOURCE_PREFIX}${stage}${SEP}`;

/** Build the stack-output key inside a *stack DO*. */
const stackOutputKey = (stage: string) => `${STACK_OUTPUT_PREFIX}${stage}`;

/**
 * Parse a resource key back into its (stage, fqn) tuple. Returns
 * undefined for keys that do not match the expected shape.
 */
const parseResourceKey = (
  key: string,
): { stage: string; fqn: string } | undefined => {
  if (!key.startsWith(RESOURCE_PREFIX)) return undefined;
  const rest = key.slice(RESOURCE_PREFIX.length);
  const sep = rest.indexOf(SEP);
  if (sep < 0) return undefined;
  return { stage: rest.slice(0, sep), fqn: rest.slice(sep + 1) };
};

/**
 * Allocate a `Uint8Array` over a fresh `ArrayBuffer` (not shared) so
 * the resulting buffer satisfies Web Crypto's `BufferSource` type
 * constraint under strict DOM typings.
 */
const allocBytes = (size: number): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new ArrayBuffer(size));
