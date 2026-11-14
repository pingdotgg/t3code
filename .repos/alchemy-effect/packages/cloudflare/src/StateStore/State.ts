import crypto from "node:crypto";
import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { AuthError } from "alchemy/Auth/AuthProvider";
import { CredentialsStore } from "alchemy/Auth/Credentials";
import { currentProfileName } from "alchemy/Auth/Profile";
import { emit } from "alchemy/Events";
import * as Interaction from "alchemy/Interaction";
import { StateApi } from "alchemy/State/HttpStateApi";
import {
  checkHttpStateStoreAuth,
  makeHttpStateStore,
  type HttpStateStoreCredentials,
} from "alchemy/State/HttpStateStore";
import { makeLocalState } from "alchemy/State/LocalState";
import * as Provisioning from "alchemy/State/Provisioning";
import { State, StateStoreError } from "alchemy/State/State";
import { recordStateStoreInit, recordStateStoreOp } from "alchemy/Telemetry/Metrics";
import { globalLogs } from "alchemy/Util/LogRecord";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Access from "../Access.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import * as Cloudflare from "../Providers.ts";
import { STATE_STORE_SCRIPT_NAME, STATE_STORE_VERSION } from "./Api.ts";
import {
  deleteStoreCredentials,
  readStoreCredentials,
  writeStoreCredentials,
  isStateStoreCredentialsStale,
} from "./CredentialsFile.ts";
import {
  deployStateStoreWorker,
  encryptionKeyLost,
  findSecretSharingWorker,
  observeDeployedVersion,
  observeStateStoreDomain,
  stateStoreSecretsExist,
  stateStoreUrl,
  validateStateStoreWorkerName,
} from "./Deploy.ts";
import { AuthTokenSecretName, EncryptionKeySecretName, stateStoreSecretName } from "./Token.ts";

const CI = Config.Boolean("CI").pipe(Config.withDefault(false));

export type CloudflareStateOptions = {
  /**
   * The Cloudflare account the store lives in. Defaults to the account your
   * Alchemy profile resolves. Pin it when your credentials reach several
   * accounts, so a login against a different one can't read or deploy the
   * store somewhere else.
   */
  readonly accountId?: string;
  /**
   * Serve the store on this hostname in one of the account's zones instead of
   * its workers.dev URL, for networks that can't reach workers.dev. Bootstrap
   * attaches it to the store's Worker as a custom domain.
   */
  readonly domain?: string;
  /**
   * The store's Worker name, for a store other than the account's default
   * `alchemy-state-store`: 1-54 lowercase letters, digits, `-` and `_`,
   * starting with a letter or digit. Its secrets are named after it, e.g.
   * `acme-state` keeps its token in `AlchemyStateStoreToken_acme_state`.
   * @default "alchemy-state-store"
   */
  readonly workerName?: string;
};

export const state = (options: CloudflareStateOptions = {}) =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const isCI = yield* CI;
      const { workerName, domain } = options;
      const scriptName = workerName ?? STATE_STORE_SCRIPT_NAME;
      const profileName = yield* currentProfileName;
      const credStore = yield* CredentialsStore;
      const context = yield* Effect.context<Effect.Services<typeof init>>();
      const store: Provisioning.StoreRef = {
        backend: "cloudflare",
        name: workerName,
        label: `Cloudflare State Store '${scriptName}'`,
        configured: options.accountId !== undefined || domain !== undefined,
      };

      const init = Effect.gen(function* () {
        yield* validateStateStoreWorkerName(scriptName);
        const accountId = yield* resolveAccountId(options.accountId);
        const deployMissing = Provisioning.deployMissing(
          store,
          bootstrap({ workerName: scriptName, profile: profileName, accountId, domain }),
        );

        const ensureLatest = ({ url, authToken }: { url: string; authToken: string }) =>
          Effect.gen(function* () {
            const observed = yield* observeServedVersion(accountId, scriptName, domain);
            if (observed === undefined) return yield* deployMissing;
            const expected = STATE_STORE_VERSION;
            const matches = observed === expected;

            const httpState = yield* ensureAccess({ url, authToken });
            if (matches) return httpState;

            // The store is out of date. Upgrade it in place.
            const upgrade = Effect.gen(function* () {
              const interaction = yield* Interaction.Interaction;
              return yield* interaction.task(
                {
                  label: `Updating Cloudflare State Store '${scriptName}'`,
                  detail: `v${observed ?? "unknown"} → v${expected}`,
                },
                deployStateStore({
                  accountId,
                  scriptName,
                  domain,
                  profileName,
                  isCI,
                  force: false,
                }).pipe(Effect.flatMap(makeCloudflareStateStore)),
              );
            }).pipe(withStateBootstrapEvents(scriptName));
            return yield* Provisioning.upgradeOutdated({ ...store, observed, expected }, upgrade);
          });

        const ensureAccess = (credentials: HttpStateStoreCredentials) =>
          Effect.gen(function* () {
            if (yield* checkHttpStateStoreAuth(credentials)) {
              return yield* makeCloudflareStateStore(credentials);
            }
            // our token is wrong, force a refresh
            const refreshed = yield* loginWithCloudflare(
              profileName,
              true,
              scriptName,
              accountId,
              domain,
            );
            if (!(yield* checkHttpStateStoreAuth(refreshed))) {
              return yield* new StateStoreError({
                message: `${store.label} authentication failed, after refreshing credentials.`,
              });
            }
            return yield* makeCloudflareStateStore(refreshed);
          });

        const credentials = yield* readStoreCredentials(credStore, profileName, scriptName);
        if (credentials) {
          // The cached `url`/`authToken` are minted per-account (the `url`
          // encodes the account via its workers.dev subdomain). If the
          // active account changed since they were written — or the file
          // predates the `accountId` field — trusting the cache would
          // silently read/write state in the wrong account, so discard it
          // and fall through to re-derivation from the current account.
          if (isStateStoreCredentialsStale(credentials, accountId)) {
            yield* Interaction.info(
              `Cloudflare State Store credentials were minted for a different ` +
                `Cloudflare account; re-deriving for the current account.`,
            );
            yield* deleteStoreCredentials(credStore, profileName, scriptName).pipe(Effect.ignore);
          } else if (!servesOn(credentials.url, domain)) {
            // The store's `domain` changed since these were cached.
            yield* deleteStoreCredentials(credStore, profileName, scriptName).pipe(Effect.ignore);
          } else {
            return yield* ensureLatest(credentials);
          }
        }
        if ((yield* observeServedVersion(accountId, scriptName, domain)) !== undefined) {
          return yield* ensureLatest(
            yield* loginWithCloudflare(profileName, false, scriptName, accountId, domain),
          );
        }
        return yield* deployMissing;
        // Account-level: filed in the global run log, not the project's.
      }).pipe(recordStateStoreInit, globalLogs, Effect.orDie);

      return yield* Effect.cached(init.pipe(Effect.provideContext(context)));
    }),
  ).pipe(
    // The Cloudflare API foundation shared with `providers()` —
    // credentials, environment, auth/access, profile + credential
    // store, and the same blanket retry policy. Without the retry
    // policy the init-time subdomain/script/secrets probes run on the
    // SDK default and give up early under Cloudflare rate limiting.
    // `provide` (not `provideMerge`) so the distilled Retry tag stays
    // out of this layer's public type.
    Layer.provide(Cloudflare.CloudflareApiLive()),
    Layer.orDie,
  );

export interface BootstrapOptions {
  /** @default "alchemy-state-store" */
  workerName?: string;
  /** The account to deploy into. Defaults to the profile's account. */
  accountId?: string;
  /** A hostname to serve the store on, attached as a custom domain. */
  domain?: string;
  /** @default false */
  force?: boolean;
  /** @default "default" */
  profile?: string;
}

/**
 * Report `state.bootstrap.*` progress events around a state-store deploy or
 * upgrade. Bootstrap runs lazily inside the plan's "loading state" phase,
 * can take many seconds (it deploys a worker), and would otherwise be
 * invisible to non-interactive renderers and traces — the Interaction task only
 * paints the local terminal.
 */
const withStateBootstrapEvents =
  (store: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      yield* emit({ type: "state.bootstrap.started", store });
      const result = yield* effect;
      yield* emit({ type: "state.bootstrap.completed", store });
      return result;
    });

export const bootstrap = (options: BootstrapOptions = {}) =>
  withStateBootstrapEvents(options.workerName ?? STATE_STORE_SCRIPT_NAME)(
    Effect.gen(function* () {
      const interaction = yield* Interaction.Interaction;
      const isCI = yield* CI;
      const profileName = options.profile ?? (yield* currentProfileName);
      const scriptName = yield* validateStateStoreWorkerName(
        options.workerName ?? STATE_STORE_SCRIPT_NAME,
      );
      const force = options.force ?? false;
      const accountId = yield* resolveAccountId(options.accountId);
      const { domain } = options;
      yield* Effect.annotateCurrentSpan({
        "alchemy.state_store.script_name": scriptName,
        "alchemy.state_store.profile": profileName,
        "alchemy.state_store.force": force,
        "alchemy.state_store.ci": isCI,
      });
      yield* annotateAccountHash(accountId);

      const observed = yield* observeServedVersion(accountId, scriptName, domain);
      const serving = observed !== undefined;
      // A store missing a secret is redeployed, which creates only the missing one.
      if (serving && !force && (yield* stateStoreSecretsExist({ accountId, scriptName }))) {
        yield* Interaction.info(
          `Worker '${scriptName}' already exists; adopting and refreshing credentials. ` +
            `Use --force to redeploy.`,
        );
        const credentials = yield* loginWithCloudflare(
          profileName,
          true,
          scriptName,
          accountId,
          domain,
        );
        if (observed === STATE_STORE_VERSION) {
          yield* forgetLegacyBootstrapStack(credentials, scriptName);
          return yield* makeCloudflareStateStore(credentials);
        }
      }
      return yield* interaction.task(
        {
          label: `${serving ? "Updating" : "Deploying"} Cloudflare State Store '${scriptName}'`,
        },
        deployStateStore({ accountId, scriptName, domain, profileName, isCI, force }).pipe(
          Effect.flatMap(makeCloudflareStateStore),
        ),
      );
    }).pipe(
      Effect.withSpan("state_store.bootstrap", {
        attributes: {
          "alchemy.state_store.op": "bootstrap",
          "alchemy.state_store.script_name": options.workerName ?? STATE_STORE_SCRIPT_NAME,
        },
      }),
      // Account-level: filed in the global run log, not the project's.
      globalLogs,
    ),
  );

export interface TeardownOptions {
  /** @default "alchemy-state-store" */
  workerName?: string;
  /** The account the store lives in. Defaults to the profile's account. */
  accountId?: string;
  /** @default "default" */
  profile?: string;
  /**
   * Delete the account Secrets Store too, but only once the state-store
   * secrets have been removed and no other secrets remain in it. A store that
   * still holds foreign secrets is left in place.
   * @default true
   */
  deleteEmptySecretsStore?: boolean;
}

/**
 * The inverse of {@link bootstrap}: tear down the Cloudflare-deployed state
 * store. Deletes the state-store Worker and the secrets it created in the
 * account Secrets Store (the bearer token + the encryption key), then deletes
 * the Secrets Store itself if it is left empty, and drops the locally cached
 * state-store credentials for the profile.
 *
 * Idempotent — missing resources are treated as already-gone, so it is safe to
 * re-run. Intended for reclaiming a throwaway account after testing; on a
 * shared account it only removes resources alchemy created.
 */
export const teardownStateStore = (options: TeardownOptions = {}) =>
  Effect.gen(function* () {
    const interaction = yield* Interaction.Interaction;
    const profileName = options.profile ?? (yield* currentProfileName);
    const scriptName = options.workerName ?? STATE_STORE_SCRIPT_NAME;
    const deleteEmptyStore = options.deleteEmptySecretsStore ?? true;
    const accountId = yield* resolveAccountId(options.accountId);

    yield* annotateAccountHash(accountId);
    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.script_name": scriptName,
      "alchemy.state_store.profile": profileName,
    });

    // 1. Delete the state-store Worker.
    yield* Interaction.info(`Deleting state store worker '${scriptName}'...`);
    yield* workers.deleteScript({ accountId, scriptName, force: true }).pipe(
      Effect.asVoid,
      Effect.catchTag("WorkerNotFound", () =>
        interaction.output.info(`  Worker '${scriptName}' not found (already gone).`),
      ),
    );

    // 2. Delete the secrets the state store created, plus any now-empty store,
    // unless another store's Worker shares them.
    const sharing = yield* findSecretSharingWorker({ accountId, scriptName });
    if (sharing !== undefined) {
      yield* Interaction.info(
        `Keeping the secrets of '${scriptName}': Worker '${sharing}' uses the same secrets.`,
      );
    }
    const ourSecretNames = new Set<string>(
      sharing === undefined
        ? [
            stateStoreSecretName(AuthTokenSecretName, scriptName),
            stateStoreSecretName(EncryptionKeySecretName, scriptName),
          ]
        : [],
    );
    const stores = yield* SecretsStore.listStores.items({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("InvalidAccountId", () => Effect.succeed([])),
    );
    for (const store of stores) {
      const secrets = yield* SecretsStore.listStoreSecrets
        .items({ accountId, storeId: store.id })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
          Effect.catchTag(["StoreNotFound", "InvalidAccountId"], () => Effect.succeed([])),
        );
      const ours = secrets.filter((s) => ourSecretNames.has(s.name));
      for (const secret of ours) {
        yield* Interaction.info(`Deleting secret '${secret.name}'...`);
        yield* SecretsStore.deleteStoreSecret({
          accountId,
          storeId: store.id,
          secretId: secret.id,
        }).pipe(
          Effect.asVoid,
          Effect.catchTag(
            ["SecretNotFound", "StoreNotFound", "NotFound", "InvalidAccountId"],
            () => Effect.void,
          ),
        );
      }
      const remaining = secrets.length - ours.length;
      if (deleteEmptyStore && remaining === 0) {
        yield* Interaction.info(`Deleting empty secrets store '${store.id}'...`);
        yield* SecretsStore.deleteStore({
          accountId,
          storeId: store.id,
          force: true,
        }).pipe(
          Effect.asVoid,
          Effect.catchTag(["StoreNotFound", "NotFound", "InvalidAccountId"], () => Effect.void),
        );
      } else if (remaining > 0) {
        yield* Interaction.info(
          `Secrets store '${store.id}' still has ${remaining} other ` +
            `secret(s); leaving it in place.`,
        );
      }
    }

    // 3. Drop the locally cached state-store credentials for this profile.
    const credStore = yield* CredentialsStore;
    yield* deleteStoreCredentials(credStore, profileName, scriptName).pipe(Effect.ignore);

    yield* Interaction.success(`Cloudflare State Store '${scriptName}' torn down.`);
  }).pipe(
    Effect.withSpan("state_store.teardown", {
      attributes: {
        "alchemy.state_store.op": "teardown",
        "alchemy.state_store.script_name": options.workerName ?? STATE_STORE_SCRIPT_NAME,
      },
    }),
  );

/**
 * Deploy (or update) the store with direct API calls, wait until it serves
 * this CLI's version, and resolve its credentials. A token this deploy created
 * is returned directly; an existing one is read back through the Worker.
 */
const deployStateStore = ({
  accountId,
  scriptName,
  domain,
  profileName,
  isCI,
  force,
}: {
  accountId: string;
  scriptName: string;
  domain: string | undefined;
  profileName: string;
  isCI: boolean;
  /** Approves replacing a lost encryption key without asking. */
  force: boolean;
}) =>
  Effect.gen(function* () {
    if (
      (yield* encryptionKeyLost({ accountId, scriptName })) &&
      !(force || (yield* confirmNewEncryptionKey(scriptName, isCI)))
    ) {
      return yield* new StateStoreError({
        message:
          `Cloudflare State Store '${scriptName}' has lost its encryption key, so the state ` +
          `it holds can no longer be decrypted. Nothing was changed. To start over with a new ` +
          `key, which leaves that state unreadable, run 'alchemy state bootstrap' in a ` +
          `terminal and confirm, or pass --force with --backend.`,
      });
    }
    const { url, authToken } = yield* deployStateStoreWorker({ accountId, scriptName, domain });
    // Cloudflare's worker upload is eventually consistent: the edge can keep
    // serving the previous version for several seconds. Wait until `/version`
    // reports the version this CLI was built against before using it.
    yield* waitForStateStoreVersion(url, scriptName, accountId);
    const credentials =
      authToken === undefined
        ? yield* loginWithCloudflare(profileName, true, scriptName, accountId, domain)
        : { url, authToken, accountId };
    if (authToken !== undefined && !isCI) {
      // CI file systems are ephemeral; credentials are re-read each run.
      yield* writeStoreCredentials(yield* CredentialsStore, profileName, scriptName, credentials);
    }
    yield* forgetLegacyBootstrapStack(credentials, scriptName);
    return credentials;
  }).pipe(
    Effect.withSpan("state_store.deploy", {
      attributes: { "alchemy.state_store.op": "deploy" },
    }),
    recordStateStoreOp("deploy"),
  );

/** Ask before giving a store that lost its encryption key a new one. Never in CI. */
const confirmNewEncryptionKey = (scriptName: string, isCI: boolean) =>
  Effect.gen(function* () {
    const interaction = yield* Effect.serviceOption(Interaction.Interaction);
    if (isCI || Option.isNone(interaction)) return false;
    return yield* interaction.value.prompt
      .confirm({
        message:
          `Cloudflare State Store '${scriptName}' has lost its encryption key, so its state ` +
          `can't be decrypted. Create a new key and start with an empty store?`,
        initialValue: false,
      })
      .pipe(Effect.orElseSucceed(() => false));
  });

/** The stack Alchemy versions before direct deploys deployed the store through. */
const LEGACY_BOOTSTRAP_STACK = "CloudflareStateStore";

/**
 * Delete the records of the stack older versions deployed the store through:
 * the store's own, and those an interrupted bootstrap left in this project's
 * local state. Destroying that stack would delete the store's Worker and
 * secrets. A failure only warns: the store refuses that stack's reads and
 * writes either way, and the next bootstrap tries again.
 */
const forgetLegacyBootstrapStack = Effect.fn("state_store.forget_legacy_stack")(
  function* (credentials: HttpStateStoreCredentials, scriptName: string) {
    const remote = yield* makeCloudflareStateStore(credentials);
    yield* remote.deleteStack({ stack: LEGACY_BOOTSTRAP_STACK });
    // An interrupted bootstrap left its stage as `<profile>_<worker>`.
    const local = yield* makeLocalState();
    const stages = yield* local.listStages(LEGACY_BOOTSTRAP_STACK);
    yield* Effect.forEach(
      stages.filter((stage) => stage.endsWith(`_${scriptName}`)),
      (stage) => local.deleteStack({ stack: LEGACY_BOOTSTRAP_STACK, stage }),
      { discard: true },
    );
  },
  (effect, _credentials, scriptName) =>
    effect.pipe(
      Effect.catch((error) =>
        Interaction.warning(
          `Couldn't delete the old '${LEGACY_BOOTSTRAP_STACK}' records of Cloudflare State ` +
            `Store '${scriptName}': ${error.message}`,
        ),
      ),
    ),
);

/**
 * The account a store lives in: the pinned one, or the profile's. Fails when
 * the credentials can't reach a pinned account, before anything is read or
 * deployed.
 */
const resolveAccountId = (pinned: string | undefined) =>
  Effect.gen(function* () {
    if (pinned === undefined) {
      return (yield* yield* CloudflareEnvironment.CloudflareEnvironment).accountId;
    }
    yield* workers.getSubdomain({ accountId: pinned }).pipe(
      Effect.mapError(
        (cause) =>
          new StateStoreError({
            message:
              `The Cloudflare State Store is pinned to account ${pinned}, but the current ` +
              `credentials can't access it. Log in to that account or change \`accountId\`.`,
            cause,
          }),
      ),
    );
    return pinned;
  });

/**
 * Log in to a Cloudflare-deployed HTTP state-store.
 *
 * 1. Find the single account-wide Secrets Store.
 * 2. Upload a short-lived edge-preview worker that binds the
 *    auth-token secret and returns its value.
 * 3. Derive the state-store worker URL: its custom `domain`, or its
 *    workers.dev URL.
 * 4. Persist `{ url, token }` under the `http-state-store`
 *    credentials file.
 *
 * Requirements are covered by the Cloudflare provider stack —
 * `CloudflareEnvironment`, `Credentials`, `HttpClient`, and
 * `FileSystem`.
 */
export const loginWithCloudflare = Effect.fn("state_store.login", {
  attributes: {
    "alchemy.state_store.op": "login",
  },
})(
  function* (
    profileName: string,
    force: boolean,
    scriptName: string = STATE_STORE_SCRIPT_NAME,
    pinnedAccountId?: string,
    domain?: string,
  ) {
    yield* Effect.annotateCurrentSpan({ "alchemy.state_store.script_name": scriptName });
    const credStore = yield* CredentialsStore;
    const isCI = yield* CI;
    const accountId = yield* resolveAccountId(pinnedAccountId);

    if (!force) {
      // try and read from the cached credentials first if not forcing (force will always refresh)
      const credentials = yield* readStoreCredentials(credStore, profileName, scriptName);
      // Ignore a cache minted for a different account (or a legacy file with
      // no `accountId`) — reusing it would hand back the wrong account's
      // state-store URL. Fall through to re-derive against `accountId`.
      if (
        credentials &&
        !isStateStoreCredentialsStale(credentials, accountId) &&
        servesOn(credentials.url, domain)
      ) {
        return credentials;
      }
    }

    const interaction = yield* Interaction.Interaction;
    const credentials = yield* interaction.task(
      { label: "Refreshing Cloudflare State Store credentials" },
      Effect.gen(function* () {
        // 1. Locate the single Secrets Store on the account.
        const store = yield* SecretsStore.listStores
          .items({ accountId })
          .pipe(Stream.runHead, Effect.map(Option.getOrUndefined));
        if (!store) {
          return yield* AuthError.make({
            message: "No Secrets Store found on this account. Deploy the state store first.",
          });
        }

        // 2. Fetch the auth-token from Secrets Store with a temporary edge-preview
        // worker, served on the custom domain when the store has one attached.
        const zoneId =
          domain === undefined
            ? undefined
            : yield* observeStateStoreDomain({ accountId, scriptName, domain });
        const authToken = yield* readSecretViaEdge(
          accountId,
          scriptName,
          store.id,
          stateStoreSecretName(AuthTokenSecretName, scriptName),
          domain !== undefined && zoneId !== undefined ? { zoneId, host: domain } : undefined,
        ).pipe(
          Effect.retry({
            while: (error) =>
              isWorkersPreviewConfigurationError(error) || isTransientEdgeSessionError(error),
            // Cap the exponential delay at 2s so 15 retries stay within
            // ~30s instead of doubling unboundedly.
            schedule: Schedule.max([
              Schedule.min([Schedule.exponential(200), Schedule.spaced("2 seconds")]),
              Schedule.recurs(15),
            ]),
          }),
        );

        // 3. Derive the deployed worker URL.
        const url = yield* stateStoreUrl({ accountId, scriptName, domain });
        const credentials = {
          url,
          authToken: authToken.trim(),
          accountId,
        };

        if (!isCI) {
          // 4. Persist credentials for subsequent invocations.
          yield* writeStoreCredentials(credStore, profileName, scriptName, credentials).pipe(
            Effect.mapError((e) =>
              AuthError.make({
                message: "Failed to write credentials",
                cause: e,
              }),
            ),
          );
        }

        return credentials;
      }),
    );
    if (!isCI) yield* interaction.output.info(`  url:     ${credentials.url}`);
    return credentials;
  },
  Effect.catchTag("EdgeSessionError", (e) =>
    Effect.fail(
      AuthError.make({
        message: `Edge-preview secret read failed: ${e.message}`,
        cause: e.cause,
      }),
    ),
  ),
);

const isStateStoreAvailable = (accountId: string, scriptName: string) =>
  workers.getScriptSetting({ accountId, scriptName }).pipe(
    Effect.map((setting) => setting !== undefined),
    Effect.catchTags({
      WorkerNotFound: () => Effect.succeed(false),
      InvalidRoute: () => Effect.succeed(false),
      // A worker that exists but has no versions (a previous deploy was
      // interrupted before any content upload) can't serve — treat it
      // as absent so bootstrap redeploys it.
      WorkerHasNoVersions: () => Effect.succeed(false),
    }),
  );

/**
 * Whether cached credentials point at where the store serves now: its
 * custom `domain`, or workers.dev without one.
 */
const servesOn = (url: string, domain: string | undefined) =>
  domain === undefined
    ? new URL(url).hostname.endsWith(".workers.dev")
    : url === `https://${domain}`;

/**
 * Does this account have a *functioning* state-store worker,
 * verified by checking the /version endpoint
 *
 * `false` means the lookups succeeded and found no store. A lookup that
 * fails, such as one the credentials aren't permitted to make, fails this
 * check: a missing store is bootstrapped, and bootstrapping over a live
 * store replaces its auth token and encryption key.
 */
const observeServedVersion = (accountId: string, scriptName: string, domain?: string) =>
  Effect.gen(function* () {
    // Ask the API whether the domain is attached before resolving it, so a
    // lookup before the first deploy can't leave a cached NXDOMAIN behind.
    const attached =
      domain === undefined ||
      (yield* observeStateStoreDomain({ accountId, scriptName, domain }).pipe(
        // Another Worker owning the domain fails as itself, not as an unknown.
        Effect.mapError((e) =>
          e._tag === "StateStoreError" ? e : existenceUnknown(scriptName)(e),
        ),
      )) !== undefined;
    if (!attached) return undefined;
    const observed = yield* Effect.gen(function* () {
      const deployed = yield* observeDeployedVersion({ accountId, scriptName });
      if (deployed !== "unrecorded") return deployed;
      // An older Alchemy deployed it without recording its version: ask the
      // Worker, which the API says exists.
      const url = yield* stateStoreUrl({ accountId, scriptName, domain }).pipe(
        // Without a workers.dev subdomain, nothing can serve the store.
        Effect.catchTag("SubdomainNotFound", () => Effect.undefined),
      );
      if (url === undefined) return undefined;
      return (yield* checkStateStoreVersion(url, scriptName, accountId)).observed;
    }).pipe(Effect.mapError(existenceUnknown(scriptName)));
    return yield* refuseNewerStore(scriptName, observed);
  });

/**
 * Fail on a store a newer Alchemy deployed: redeploying this version's Worker
 * over it could leave its state in a format this version doesn't know.
 */
const refuseNewerStore = (scriptName: string, observed: number | undefined) =>
  observed !== undefined && observed > STATE_STORE_VERSION
    ? Effect.fail(
        new StateStoreError({
          message:
            `Cloudflare State Store '${scriptName}' runs v${observed}, newer than this ` +
            `Alchemy's v${STATE_STORE_VERSION}, so it was left untouched. Upgrade alchemy to use it.`,
        }),
      )
    : Effect.succeed(observed);

const existenceUnknown =
  (scriptName: string) =>
  (cause: Error & { readonly _tag: string }): StateStoreError =>
    new StateStoreError({
      message:
        `Could not determine whether Cloudflare State Store '${scriptName}' exists, ` +
        `so it was left untouched: ${cause.message}. ` +
        (cause._tag === "Forbidden"
          ? `Check that the Cloudflare credentials can read Workers scripts (Workers Scripts Read).`
          : `Run the command again.`),
      cause,
    });

const makeCloudflareStateStore = Effect.fn(function* ({
  url,
  authToken,
}: {
  url: string;
  authToken: string;
}) {
  const access = yield* Access.Access;
  const accessHeaders = yield* access.getAccessHeaders(new URL(url).host);
  return yield* makeHttpStateStore({
    url,
    authToken,
    transformClient: HttpClientRequest.setHeaders(accessHeaders),
    id: "cloudflare-http",
  });
});

export class StateStoreVersionNotReady extends Data.TaggedError("StateStoreVersionNotReady")<{
  readonly expected: number;
  readonly observed: number | undefined;
}> {
  override get message() {
    return `Cloudflare State Store version not ready (expected v${this.expected}, observed v${this.observed ?? "unknown"}).`;
  }
}

const waitForStateStoreVersion = (url: string, scriptName: string, accountId: string) =>
  Effect.gen(function* () {
    // Right after a deploy the store may not answer yet: keep polling.
    const { matches, expected, observed } = yield* checkStateStoreVersion(
      url,
      scriptName,
      accountId,
    ).pipe(Effect.orElseSucceed(() => unknownVersion));
    if (!matches) {
      return yield* new StateStoreVersionNotReady({ expected, observed });
    }
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof StateStoreVersionNotReady,
      // Edge propagation is usually sub-second but production traces
      // show redeploys occasionally serving the old version for well
      // over 10s. Poll for ~30s before failing loudly.
      schedule: Schedule.max([Schedule.spaced("500 millis"), Schedule.recurs(60)]),
    }),
    // Each poll retries on its own, so bound the whole wait.
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(
          new StateStoreError({
            message:
              `Cloudflare State Store '${scriptName}' was deployed but ${url} did not serve ` +
              `v${STATE_STORE_VERSION} within 2 minutes. Its secrets and state are unchanged; ` +
              `run the command again.`,
          }),
        ),
    }),
    Effect.withSpan("state_store.wait_for_version", {
      attributes: {
        "alchemy.state_store.op": "wait_for_version",
        "alchemy.state_store.url": url,
        "alchemy.state_store.expected_version": STATE_STORE_VERSION,
      },
    }),
  );

const checkStateStoreVersion = Effect.fn("state_store.check_version", {
  attributes: { "alchemy.state_store.op": "check_version" },
})(function* (url: string, scriptName: string, accountId: string) {
  const client = yield* HttpApiClient.make(StateApi, { baseUrl: url });
  const isAvailable = yield* Effect.cached(isStateStoreAvailable(accountId, scriptName));
  // The /version route may 404 transiently after a fresh deploy
  // while Cloudflare propagates the new script to the edge, and may
  // also surface transport-level blips on cold workers.dev hosts.
  // Retry the probe itself for ~10s before giving up. `observed` is
  // `undefined` only when the worker is confirmed absent; a probe that
  // still fails after that budget fails the check.
  const result = yield* client.version.getVersion().pipe(
    Effect.catchTag("HttpClientError", (e) =>
      // if we get a 404 here, it means we assumed the worker shoudl exist, but it does not
      // we should do a check to see if it does
      e.response?.status === 404
        ? isAvailable.pipe(
            Effect.flatMap((isAvailable) =>
              // if the worker is available, then we should assume it was recently created and retry by propagating the error
              // otherwise, return undefined (we don't know the version, there is no worker)
              isAvailable ? Effect.fail(e) : Effect.undefined,
            ),
          )
        : Effect.fail(e),
    ),
    Effect.retry({
      schedule: Schedule.max([Schedule.spaced("250 millis"), Schedule.recurs(40)]),
    }),
  );
  const matches = result?.version === STATE_STORE_VERSION;
  yield* Effect.annotateCurrentSpan({
    "alchemy.state_store.expected_version": STATE_STORE_VERSION,
    "alchemy.state_store.observed_version": result?.version ?? -1,
    "alchemy.state_store.version_match": matches,
  });
  return {
    matches,
    expected: STATE_STORE_VERSION,
    observed: result?.version,
  };
});

/** A version check that failed, for callers that read it as an outdated store. */
const unknownVersion = {
  matches: false,
  expected: STATE_STORE_VERSION,
  observed: undefined,
} as const;

/**
 * Tiny ES-module worker that reads `env.SECRET.get()` and echoes it
 * back. Uploaded as an ephemeral edge-preview, called once, then
 * discarded — see {@link readSecretViaEdge}.
 */
const SECRET_PROBE_SOURCE = `export default {
  async fetch(_request, env) {
    try {
      const value = await env.SECRET.get();
      return new Response(value ?? "", { status: 200, headers: { "content-type": "text/plain" } });
    } catch (e) {
      return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 500 });
    }
  },
};`;

/**
 * Upload an ephemeral edge-preview build of the given (already
 * deployed) script that binds the requested Secrets Store secret,
 * call it once with the preview token, and return the decoded value.
 * The Cloudflare REST API deliberately hides secret values; only
 * worker bindings can resolve them, so this is the out-of-band path.
 *
 * `scriptName` MUST be a script that is already deployed on the
 * account with workers.dev enabled — the `cf-workers-preview-token`
 * header swaps our probe code in for an existing route, it does not
 * create one. Using an undeployed name (or a deployed script that
 * doesn't have workers.dev enabled) makes the workers.dev edge serve
 * a generic Cloudflare 400 HTML error page instead of routing to the
 * preview. The state-store script itself satisfies both conditions.
 */
const readSecretViaEdge = (
  accountId: string,
  scriptName: string,
  storeId: string,
  secretName: string,
  route?: { readonly zoneId: string; readonly host: string },
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const file = new File([SECRET_PROBE_SOURCE], "worker.js", {
      type: "application/javascript+module",
    });
    // The preview runs in the store's account, which a pin may set apart
    // from the profile's.
    const environment = yield* CloudflareEnvironment.CloudflareEnvironment;
    const session = yield* createEdgeSession({
      scriptName,
      files: [file],
      bindings: [{ type: "secrets_store_secret", name: "SECRET", secretName, storeId }],
      route,
    }).pipe(
      Effect.provideService(
        CloudflareEnvironment.CloudflareEnvironment,
        Effect.map(environment, (credentials) => ({ ...credentials, accountId })),
      ),
    );
    const response = yield* http.get(session.url, {
      headers: session.headers,
    });
    if (response.status !== 200) {
      const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
      // TEMP(sam): dump the full body so we can capture the exact
      // Cloudflare error page when the probe fails in the wild. Drop
      // this once we've confirmed the routing fix covers all the
      // observed failure modes.
      yield* Effect.logWarning(
        `Secret probe failed (${response.status}) at ${session.url}\n${body}`,
      );
      return yield* new EdgeSessionError({
        message: `Secret probe returned ${response.status}: ${body.slice(0, 200)}`,
      });
    }
    return yield* response.text;
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof EdgeSessionError
        ? cause
        : new EdgeSessionError({ message: "Failed to read secret", cause }),
    ),
    Effect.withSpan("state_store.read_secret_via_edge", {
      attributes: {
        "alchemy.state_store.op": "read_secret_via_edge",
        "alchemy.state_store.script_name": scriptName,
        "alchemy.state_store.secret_name": secretName,
      },
    }),
  );

const isWorkersPreviewConfigurationError = (error: unknown) =>
  error instanceof EdgeSessionError &&
  (error.message.includes("Invalid Workers Preview configuration") ||
    error.message.includes("Error 1031"));

/**
 * Edge-preview reads are flaky in ways that clear up on their own:
 * the workers.dev edge can serve a generic Cloudflare 400/502 HTML
 * page while preview routing propagates ("Secret probe returned
 * ..."), the session-create call can hit transient API blips, and the
 * probe fetch can fail at the transport level ("fetch failed").
 * Retry everything except causes that are clearly permanent
 * (bad credentials, invalid routes).
 *
 * @internal exported for unit testing.
 */
export const isTransientEdgeSessionError = (error: unknown): boolean => {
  if (!(error instanceof EdgeSessionError)) return false;
  // Non-200 probe responses are edge-propagation flakes, not client bugs.
  if (error.message.startsWith("Secret probe returned")) return true;
  const tag = (error.cause as { _tag?: unknown } | undefined)?._tag;
  if (
    typeof tag === "string" &&
    (tag.startsWith("Unauthorized") ||
      tag === "Forbidden" ||
      tag === "InvalidRoute" ||
      tag === "AuthError")
  ) {
    return false;
  }
  return true;
};

/**
 * SHA-256 hex digest of the Cloudflare account ID. Used as a stable
 * pseudonymous identifier on telemetry spans so the dashboard can
 * count distinct state-store deployments without leaking the raw
 * accountId. Mirrors the `alchemy.git.origin_hash` pattern in
 * `Telemetry/Attributes.ts`.
 */
const hashAccountId = (accountId: string) =>
  Effect.sync(() => crypto.createHash("sha256").update(accountId).digest("hex"));

/**
 * Best-effort Cloudflare-account-hash annotation on the current span, unless
 * the `NO_TRACK` env var opts out.
 */
const annotateAccountHash = (accountId: string) =>
  Effect.gen(function* () {
    if (yield* Config.Boolean("NO_TRACK").pipe(Config.withDefault(false))) return;
    yield* Effect.annotateCurrentSpan(
      "alchemy.cloudflare.account_hash",
      yield* hashAccountId(accountId),
    );
  }).pipe(Effect.ignore);
