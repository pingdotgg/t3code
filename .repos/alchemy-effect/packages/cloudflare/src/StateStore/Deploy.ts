import crypto from "node:crypto";
import * as dns from "node:dns/promises";
import { DEFAULT_COMPATIBILITY_DATE } from "@alchemy.run/cloudflare-runtime/core/internal/constants";
import * as durableObjects from "@distilled.cloud/cloudflare/durable-objects";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as zones from "@distilled.cloud/cloudflare/zones";
import { StateStoreError } from "alchemy/State/State";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { waitForSecretActive } from "../SecretsStore/Secret.ts";
import { getCompatibility } from "../Workers/Compatibility.ts";
import { WorkerBundle } from "../Workers/Sources/Rolldown.ts";
import { contentTypeForModule, putWorkerScript } from "../Workers/WorkerProvider.ts";
import { resolveZoneId } from "../Zone/lookup.ts";
import { API_MAIN, STATE_STORE_VERSION } from "./Api.ts";
import {
  AuthTokenBinding,
  AuthTokenSecretName,
  EncryptionKeyBinding,
  EncryptionKeySecretName,
  stateStoreSecretName,
} from "./Token.ts";

/** The Durable Object class holding every store's state. Its name must never change. */
const STORE_CLASS = "Store";

/** The stack name the Worker's runtime reports, kept from the stack-deployed era. */
const RUNTIME_STACK_NAME = "CloudflareStateStore";

/**
 * Deploy a Cloudflare State Store Worker with direct API calls.
 *
 * Every step is idempotent and only ever adds what is missing: the account's
 * Secrets Store and the two state-store secrets are created when absent and
 * never updated or deleted, so redeploying cannot rotate the auth token or
 * lose the encryption key. The Worker itself is re-uploaded on every call
 * with the same `Store` Durable Object class, keeping its stored state.
 *
 * With a `domain`, the Worker is also attached to that hostname as a custom
 * domain and served there.
 *
 * Returns the Worker's URL, and the auth token when this call created it
 * (an existing token can only be read back through a Worker binding).
 */
export const deployStateStoreWorker = Effect.fn("state_store.deploy_worker")(function* ({
  accountId,
  scriptName,
  domain,
}: {
  accountId: string;
  scriptName: string;
  domain: string | undefined;
}) {
  yield* Effect.annotateCurrentSpan({ "alchemy.state_store.script_name": scriptName });
  yield* validateStateStoreWorkerName(scriptName);
  // Fail on secrets or a hostname another Worker owns before changing anything.
  const sharing = yield* findSecretSharingWorker({ accountId, scriptName });
  if (sharing !== undefined) {
    return yield* new StateStoreError({
      message:
        `Cannot deploy the Cloudflare State Store '${scriptName}': its secrets would be shared ` +
        `with Worker '${sharing}', because secret names replace '-' with '_'. Choose a ` +
        `name that differs from '${sharing}' by more than '-' and '_'.`,
    });
  }
  if (domain !== undefined) yield* observeStateStoreDomain({ accountId, scriptName, domain });
  const storeId = yield* ensureSecretsStore(accountId);
  const authToken = yield* ensureSecret({
    accountId,
    storeId,
    name: stateStoreSecretName(AuthTokenSecretName, scriptName),
  });
  yield* ensureSecret({
    accountId,
    storeId,
    name: stateStoreSecretName(EncryptionKeySecretName, scriptName),
  });

  const compatibility = getCompatibility({
    main: API_MAIN,
    compatibility: { date: DEFAULT_COMPATIBILITY_DATE },
  });
  const bundler = yield* WorkerBundle;
  const bundle = yield* bundler.build({
    id: "Api",
    main: API_MAIN,
    compatibility,
    entry: {
      kind: "effect",
      // The entry only needs the class name to export the Durable Object bridge.
      exports: {
        [STORE_CLASS]: {
          kind: "durableObject",
          constructor: Effect.never,
          services: Context.empty(),
        },
      },
    },
    stack: { name: RUNTIME_STACK_NAME, stage: scriptName },
    extraOptions: undefined,
  });

  yield* putWorkerScript({
    accountId,
    scriptName,
    dispatchNamespace: undefined,
    metadata: {
      mainModule: bundle.files[0]!.path,
      compatibilityDate: compatibility.date,
      compatibilityFlags: compatibility.flags,
      bindings: [
        { type: "plain_text", name: "ALCHEMY_PHASE", text: "runtime" },
        { type: "plain_text", name: "ALCHEMY_WORKER_NAME", text: scriptName },
        { type: "plain_text", name: "ALCHEMY_STACK_NAME", text: RUNTIME_STACK_NAME },
        { type: "plain_text", name: "ALCHEMY_STAGE", text: scriptName },
        { type: "plain_text", name: "ALCHEMY_CLOUDFLARE_ACCOUNT_ID", text: accountId },
        {
          type: "plain_text",
          name: STATE_STORE_VERSION_BINDING,
          text: String(STATE_STORE_VERSION),
        },
        {
          type: "secrets_store_secret",
          name: AuthTokenBinding,
          storeId,
          secretName: stateStoreSecretName(AuthTokenSecretName, scriptName),
        },
        {
          type: "secrets_store_secret",
          name: EncryptionKeyBinding,
          storeId,
          secretName: stateStoreSecretName(EncryptionKeySecretName, scriptName),
        },
        { type: "durable_object_namespace", name: STORE_CLASS, className: STORE_CLASS },
      ],
      exports: {
        [STORE_CLASS]: {
          type: "durable-object",
          storage: yield* observedStoreStorage(accountId, scriptName),
        },
      },
      observability: { enabled: true, logs: { enabled: true, invocationLogs: true } },
    },
    files: bundle.files.map(
      (file) =>
        new File([file.content as BlobPart], file.path, {
          type: contentTypeForModule(file.path),
        }),
    ),
  });

  yield* workers.createScriptSubdomain({
    accountId,
    scriptName,
    enabled: true,
    previewsEnabled: true,
  });
  if (domain !== undefined) yield* attachDomain({ accountId, scriptName, domain });
  return { url: yield* stateStoreUrl({ accountId, scriptName, domain }), authToken };
});

/**
 * A store's Worker name: lowercase letters, digits, `-` and `_`, starting with
 * a letter or digit, at most 54 characters. The store enables workers.dev
 * previews, and Cloudflare rejects a longer script name with previews enabled
 * (the preview hostname prefixes it); the cap also keeps its secret names well
 * under the Secrets Store's 255.
 */
export const validateStateStoreWorkerName = (scriptName: string) =>
  /^[a-z0-9][a-z0-9_-]{0,53}$/.test(scriptName)
    ? Effect.succeed(scriptName)
    : Effect.fail(
        new StateStoreError({
          message:
            `Invalid Cloudflare State Store Worker name '${scriptName}': use 1-54 lowercase ` +
            `letters, digits, '-' and '_', starting with a letter or digit.`,
        }),
      );

/**
 * Another Worker whose store's secrets have the same names as this store's.
 * Secret names replace every character other than a letter, digit or `_` with
 * `_`, so the stores `team-a` and `team_a` would share one token and key.
 */
export const findSecretSharingWorker = Effect.fn(function* ({
  accountId,
  scriptName,
}: {
  accountId: string;
  scriptName: string;
}) {
  const secretName = stateStoreSecretName(AuthTokenSecretName, scriptName);
  return yield* workers.listScripts.items({ accountId }).pipe(
    Stream.map((script) => script.id ?? undefined),
    Stream.filter(
      (name): name is string =>
        name !== undefined &&
        name !== scriptName &&
        stateStoreSecretName(AuthTokenSecretName, name) === secretName,
    ),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
});

/** The binding each deployed store records its version in, read back through the API. */
const STATE_STORE_VERSION_BINDING = "ALCHEMY_STATE_STORE_VERSION";

/**
 * The store's version as Cloudflare's API reports it, `undefined` when it has
 * no Worker, or `"unrecorded"` for a Worker an older Alchemy deployed without
 * recording it. The edge can keep serving a deleted or replaced Worker for a
 * while, so decisions use this rather than what `/version` answers.
 */
export const observeDeployedVersion = Effect.fn(function* ({
  accountId,
  scriptName,
}: {
  accountId: string;
  scriptName: string;
}) {
  const settings = yield* workers
    .getScriptScriptAndVersionSetting({ accountId, scriptName })
    .pipe(Effect.catchTag(["WorkerNotFound", "WorkerHasNoVersions"], () => Effect.undefined));
  if (settings === undefined) return undefined;
  const binding = (settings.bindings ?? []).find(
    (binding) => binding.name === STATE_STORE_VERSION_BINDING,
  );
  const version = binding !== undefined && "text" in binding ? Number(binding.text) : Number.NaN;
  return Number.isInteger(version) ? version : ("unrecorded" as const);
});

/** The origin a store serves on: its custom domain, or its workers.dev URL. */
export const stateStoreUrl = Effect.fn(function* ({
  accountId,
  scriptName,
  domain,
}: {
  accountId: string;
  scriptName: string;
  domain: string | undefined;
}) {
  if (domain !== undefined) return `https://${domain}`;
  const { subdomain } = yield* workers.getSubdomain({ accountId });
  return `https://${scriptName}.${subdomain}.workers.dev`;
});

/**
 * The zone of the custom domain `domain` when it is attached to this Worker,
 * or `undefined`. Fails when another Worker owns the hostname.
 */
export const observeStateStoreDomain = Effect.fn(function* ({
  accountId,
  scriptName,
  domain,
}: {
  accountId: string;
  scriptName: string;
  domain: string;
}) {
  const { result } = yield* workers.listDomains({ accountId, hostname: domain });
  const attached = (result ?? []).find((d) => d.hostname === domain);
  if (attached === undefined) return undefined;
  if (attached.service !== scriptName) {
    return yield* new StateStoreError({
      message:
        `Cannot serve the Cloudflare State Store '${scriptName}' on '${domain}': it is ` +
        `already attached to Worker '${attached.service ?? "<unknown>"}'.`,
    });
  }
  return attached.zoneId ?? undefined;
});

/** Attach `domain` to the Worker as a custom domain, unless it already is. */
const attachDomain = Effect.fn(function* ({
  accountId,
  scriptName,
  domain,
}: {
  accountId: string;
  scriptName: string;
  domain: string;
}) {
  if ((yield* observeStateStoreDomain({ accountId, scriptName, domain })) !== undefined) return;
  const zoneId = yield* resolveZoneId({ accountId, zone: undefined, hostname: domain }).pipe(
    Effect.mapError(
      (cause) =>
        new StateStoreError({
          message: `Couldn't find the Cloudflare zone of '${domain}' on account ${accountId}.`,
          cause,
        }),
    ),
  );
  yield* workers.putDomain({ accountId, hostname: domain, service: scriptName, zoneId }).pipe(
    // The script registry can lag the upload by a few seconds.
    Effect.retry({
      while: (error) => error._tag === "WorkerNotFound",
      schedule: Schedule.max([Schedule.exponential(200), Schedule.recurs(15)]),
    }),
  );
  yield* waitForAuthoritativeDns(zoneId, domain);
});

/**
 * Wait until the zone's nameservers answer for a newly attached `domain`.
 * Resolving it any earlier caches NXDOMAIN in the local resolver for the
 * zone's negative TTL (30 minutes on Cloudflare), and the store would be
 * unreachable from this machine for that long.
 */
const waitForAuthoritativeDns = Effect.fn(function* (zoneId: string, domain: string) {
  const { nameServers } = yield* zones.getZone({ zoneId });
  const servers = yield* Effect.forEach(nameServers, (ns) =>
    Effect.tryPromise(() => dns.resolve4(ns)).pipe(Effect.orElseSucceed(() => [])),
  ).pipe(Effect.map((ips) => ips.flat()));
  if (servers.length === 0) return;
  // A fresh resolver per attempt: one caches the NXDOMAIN it got first.
  const resolver = Effect.sync(() => {
    const resolver = new dns.Resolver({ timeout: 2_000, tries: 1 });
    resolver.setServers(servers);
    return resolver;
  });
  yield* resolver.pipe(
    Effect.flatMap((resolver) => Effect.tryPromise(() => resolver.resolve4(domain))),
    Effect.filterOrFail((addresses) => addresses.length > 0),
    // Cloudflare can take a minute to publish a re-attached custom domain.
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 45 }),
    Effect.mapError(
      (cause) =>
        new StateStoreError({
          message: `'${domain}' was attached to the State Store but its DNS record never appeared.`,
          cause,
        }),
    ),
  );
});

/** Whether the store's auth token and encryption key both exist. */
export const stateStoreSecretsExist = Effect.fn(function* ({
  accountId,
  scriptName,
}: {
  accountId: string;
  scriptName: string;
}) {
  const names = new Set([
    stateStoreSecretName(AuthTokenSecretName, scriptName),
    stateStoreSecretName(EncryptionKeySecretName, scriptName),
  ]);
  const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
  if (Option.isNone(store)) return false;
  const found = yield* secretsStore.listStoreSecrets
    .items({ accountId, storeId: store.value.id })
    .pipe(
      Stream.filter((secret) => names.has(secret.name)),
      Stream.runCollect,
    );
  return new Set(Array.from(found, (secret) => secret.name)).size === names.size;
});

/**
 * Whether a store that may hold state has lost its encryption key: its Worker
 * exists, so it served state encrypted with a key, but the key is gone. A
 * listing can lag a create, so the key must be missing from several reads.
 */
export const encryptionKeyLost = Effect.fn(function* ({
  accountId,
  scriptName,
}: {
  accountId: string;
  scriptName: string;
}) {
  const hasWorker = yield* workers.getScriptSetting({ accountId, scriptName }).pipe(
    Effect.as(true),
    Effect.catchTag(["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"], () =>
      Effect.succeed(false),
    ),
  );
  if (!hasWorker) return false;
  const name = stateStoreSecretName(EncryptionKeySecretName, scriptName);
  const listed = Effect.gen(function* () {
    const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
    if (Option.isNone(store)) return false;
    return yield* secretsStore.listStoreSecrets.items({ accountId, storeId: store.value.id }).pipe(
      Stream.filter((secret) => secret.name === name),
      Stream.runHead,
      Effect.map(Option.isSome),
    );
  });
  const found = yield* listed.pipe(
    Effect.repeat({ until: (found) => found, schedule: Schedule.spaced("2 seconds"), times: 3 }),
  );
  return !found;
});

/** The account's Secrets Store (Cloudflare allows one), created when missing. */
const ensureSecretsStore = Effect.fn(function* (accountId: string) {
  const first = secretsStore.listStores
    .items({ accountId })
    .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
  const existing = yield* first;
  if (existing) return existing.id;
  const created = yield* secretsStore
    .createStore({ accountId, name: "default_secrets_store" })
    .pipe(
      // A concurrent bootstrap created it first.
      Effect.catchTag("MaximumStoresExceeded", () => Effect.undefined),
    );
  if (created) return created.id;
  const raced = yield* first;
  if (raced) return raced.id;
  return yield* Effect.die(
    new Error(`Cloudflare reports a Secrets Store on account ${accountId} but lists none.`),
  );
});

/**
 * Create a secret holding 32 random hex-encoded bytes, unless one with this
 * name exists. Returns the value only when this call created it; an existing
 * secret is left exactly as it is.
 */
const ensureSecret = Effect.fn(function* ({
  accountId,
  storeId,
  name,
}: {
  accountId: string;
  storeId: string;
  name: string;
}) {
  const exists = yield* secretsStore.listStoreSecrets.items({ accountId, storeId }).pipe(
    Stream.filter((secret) => secret.name === name),
    Stream.runHead,
    Effect.map(Option.isSome),
  );
  if (exists) return undefined;
  const value = yield* Effect.sync(() => crypto.randomBytes(32).toString("hex"));
  const created = yield* secretsStore
    .createStoreSecret({
      accountId,
      storeId,
      body: [{ name, scopes: ["workers"], value, comment: "Alchemy Cloudflare State Store" }],
    })
    .pipe(
      // A concurrent bootstrap created it first; keep theirs.
      Effect.catchTag("SecretNameAlreadyExists", () => Effect.undefined),
    );
  if (!created) return undefined;
  const secret = created.result[0]!;
  yield* waitForSecretActive({ accountId, storeId, secretId: secret.id }, "pending");
  return value;
});

/** The `Store` class's storage backend as deployed; SQLite for a new store. */
const observedStoreStorage = (accountId: string, scriptName: string) =>
  durableObjects.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.script === scriptName && ns.class === STORE_CLASS),
    Stream.runHead,
    Effect.map((ns) =>
      Option.isSome(ns) && ns.value.useSqlite === false
        ? ("legacy-kv" as const)
        : ("sqlite" as const),
    ),
  );
