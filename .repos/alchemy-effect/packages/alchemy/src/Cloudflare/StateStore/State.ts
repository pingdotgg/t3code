import * as SecretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";
import crypto from "node:crypto";

import * as Config from "effect/Config";
import { isHttpClientError } from "effect/unstable/http/HttpClientError";
import { adopt } from "../../AdoptPolicy.ts";
import { AuthError } from "../../Auth/AuthProvider.ts";
import {
  CredentialsStore,
  CredentialsStoreLive,
} from "../../Auth/Credentials.ts";
import { ALCHEMY_PROFILE, ProfileLive } from "../../Auth/Profile.ts";
import * as Cloudflare from "../../Cloudflare/Providers.ts";
import { deploy } from "../../Deploy.ts";
import * as Output from "../../Output.ts";
import * as Alchemy from "../../Stack.ts";
import { StateApi } from "../../State/HttpStateApi.ts";
import {
  checkHttpStateStoreAuth,
  makeHttpStateStore,
  type HttpStateStoreCredentials,
} from "../../State/HttpStateStore.ts";
import { makeLocalState } from "../../State/LocalState.ts";
import { State, type StateService } from "../../State/State.ts";
import {
  recordStateStoreInit,
  recordStateStoreOp,
} from "../../Telemetry/Metrics.ts";
import * as Clank from "../../Util/Clank.ts";
import * as Access from "../Access.ts";
import { CloudflareAuth } from "../Auth/AuthProvider.ts";
import * as CloudflareEnvironment from "../CloudflareEnvironment.ts";
import * as Credentials from "../Credentials.ts";
import { EdgeSessionError, createEdgeSession } from "../EdgeSession.ts";
import Api, { STATE_STORE_SCRIPT_NAME, STATE_STORE_VERSION } from "./Api.ts";
import { AuthToken, AuthTokenSecretName, TokenValue } from "./Token.ts";

const CI = Config.boolean("CI").pipe(Config.withDefault(false));

/** Filename used for stored credentials under the profile directory. */
const CREDENTIALS_FILE = "cloudflare-state-store";

export const state = () =>
  Layer.effect(
    State,
    Effect.gen(function* () {
      const isCI = yield* CI;
      const scriptName = STATE_STORE_SCRIPT_NAME;
      const profileName = yield* ALCHEMY_PROFILE;
      const localStage = `${profileName}_${scriptName}`;
      const credStore = yield* CredentialsStore;
      const context = yield* Effect.context<Effect.Services<typeof init>>();

      const init = Effect.gen(function* () {
        if (yield* hasLocalStack(localStage)) {
          // if there's still a local stack, then we need to finish the bootstrap
          // TODO(sam): what if the local stack was
          return yield* deployWithLocalState({
            scriptName,
            profileName,
            isCI,
            force: false,
          });
        }

        const ensureLatest = ({
          url,
          authToken,
        }: {
          url: string;
          authToken: string;
        }) =>
          Effect.gen(function* () {
            const { matches, expected, observed } =
              yield* checkStateStoreVersion(url);

            if (observed === undefined) {
              const shouldDeploy = yield* Clank.confirm({
                message: `Cloudflare State Store '${scriptName}' is not available. Do you want to deploy it?`,
              });
              if (shouldDeploy) {
                return yield* bootstrap({
                  workerName: scriptName,
                  profile: profileName,
                });
              } else {
                return yield* Effect.die(new Clank.PromptCancelled());
              }
            }

            const httpState = yield* ensureAccess({ url, authToken });
            if (matches) {
              return httpState;
            } else if (isCI) {
              return yield* Effect.die(
                new AuthError({
                  message: `Cloudflare State store not found. Run 'alchemy bootstrap cloudflare --profile <your-ci-profile>' to deploy it first.`,
                }),
              );
            } else {
              const shouldDeploy = yield* Clank.confirm({
                message:
                  `Cloudflare State Store '${scriptName}' is out of date ` +
                  `(expected v${expected}, observed v${observed ?? "unknown"})`,
              });
              if (shouldDeploy) {
                const stateStoreOptions = yield* deployStateStore({
                  stage: scriptName,
                  state: httpState,
                  force: false,
                });
                return yield* makeCloudflareStateStore(stateStoreOptions);
              } else {
                return yield* Effect.die(new Clank.PromptCancelled());
              }
            }
          });

        const ensureAccess = (credentials: HttpStateStoreCredentials) =>
          Effect.gen(function* () {
            const isAuth = yield* checkHttpStateStoreAuth(credentials);
            if (!isAuth) {
              // our token is wrong, force a refresh
              yield* Clank.info(
                `Cloudflare State store authentication failed, refreshing credentials...`,
              );
              const credentials = yield* loginWithCloudflare(profileName, true);
              if (!(yield* checkHttpStateStoreAuth(credentials))) {
                return yield* Effect.die(
                  new AuthError({
                    message: `Cloudflare State store authentication failed, after refreshing credentials.`,
                  }),
                );
              }
              return yield* makeCloudflareStateStore(credentials);
            }
            return yield* makeCloudflareStateStore(credentials);
          });

        const credentials = yield* credStore.read<HttpStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
        );
        if (credentials) {
          return yield* ensureLatest(credentials);
        }
        const workerExists = yield* isStateStoreAvailable(scriptName);
        if (workerExists) {
          return yield* ensureLatest(
            yield* loginWithCloudflare(profileName, false),
          );
        } else if (isCI) {
          // TODO(sam): do we want to support bootstrapping the state store from CI?
          // for now - just die here
          return yield* Effect.die(
            new AuthError({
              message: `Cloudflare State store not found. Run 'alchemy bootstrap cloudflare --profile <your-ci-profile>' to deploy it first.`,
            }),
          );
        } else {
          return yield* Clank.confirm({
            message:
              "Cloudflare State Store not found. Do you want to deploy it?",
          }).pipe(
            Effect.flatMap((shouldDeploy) =>
              shouldDeploy
                ? bootstrap()
                : Effect.die(new Clank.PromptCancelled()),
            ),
          );
        }
      }).pipe(recordStateStoreInit, Effect.orDie);

      return yield* Effect.cached(init.pipe(Effect.provideContext(context)));
    }),
  ).pipe(
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(CloudflareEnvironment.fromProfile()),
    Layer.provideMerge(CloudflareAuth),
    Layer.provideMerge(Access.AccessLive),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

export interface BootstrapOptions {
  /** @default "alchemy-state-store" */
  workerName?: string;
  /** @default false */
  force?: boolean;
  /** @default "default" */
  profile?: string;
}

export const bootstrap = (options: BootstrapOptions = {}) =>
  Effect.gen(function* () {
    const isCI = yield* CI;
    const profileName = options.profile ?? (yield* ALCHEMY_PROFILE);
    const scriptName = options.workerName ?? STATE_STORE_SCRIPT_NAME;
    const force = options.force ?? false;
    const localStage = `${profileName}_${scriptName}`;
    yield* Effect.annotateCurrentSpan({
      "alchemy.state_store.script_name": scriptName,
      "alchemy.state_store.profile": profileName,
      "alchemy.state_store.force": force,
      "alchemy.state_store.ci": isCI,
    });
    yield* annotateAccountHash();

    if (yield* hasLocalStack(localStage)) {
      // if there's a local stack still, we can assume we did not finish hoisting it, so finish that
      yield* Clank.info(
        `Resuming Cloudflare State Store '${scriptName}' deployment...`,
      );
      // resume deployment
      return yield* deployWithLocalState({
        scriptName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Cloudflare State Store '${scriptName}' is ready.`),
        ),
      );
    }

    const workerExists = yield* isStateStoreAvailable(scriptName);
    if (workerExists) {
      // this is a regular update, let's check if it needs an update and refresh credentials
      if (!force) {
        yield* Clank.info(
          `Worker '${scriptName}' already exists; adopting and refreshing credentials. ` +
            `Use --force to redeploy.`,
        );
      }
      const credentials = yield* loginWithCloudflare(
        profileName,
        // force refresh during
        true,
      );
      const { url, authToken } = credentials;
      if (!isCI) {
        // we don't write credentials in CI because the file system is ephemeral
        const store = yield* CredentialsStore;
        yield* store.write<HttpStateStoreCredentials>(
          profileName,
          CREDENTIALS_FILE,
          credentials,
        );
      }
      const { matches, expected, observed } =
        yield* checkStateStoreVersion(url);
      const httpState = yield* makeCloudflareStateStore({ url, authToken });
      if (!matches || force) {
        if (matches && force) {
          yield* Clank.info(
            `Cloudflare State Store '${scriptName}' is up to date; force redeploying...`,
          );
        } else {
          yield* Clank.info(
            `Cloudflare State Store '${scriptName}' is out of date ` +
              `(expected v${expected}, observed v${observed ?? "unknown"}); redeploying...`,
          );
        }
        return yield* makeCloudflareStateStore(
          yield* deployStateStore({
            stage: scriptName,
            state: httpState,
            force,
          }),
        );
      } else {
        return httpState;
      }
    } else {
      // fresh deploy - deploy from local for the first time
      yield* Clank.info(`Deploying Cloudflare State Store '${scriptName}'...`);
      return yield* deployWithLocalState({
        scriptName,
        profileName,
        isCI,
        force,
      }).pipe(
        Effect.tap(() =>
          Clank.success(`Cloudflare State Store '${scriptName}' is ready.`),
        ),
      );
    }
  }).pipe(
    Effect.withSpan("state_store.bootstrap", {
      attributes: {
        "alchemy.state_store.op": "bootstrap",
        "alchemy.state_store.script_name":
          options.workerName ?? STATE_STORE_SCRIPT_NAME,
      },
    }),
  );

const deployStateStore = ({
  stage,
  state,
  force,
}: {
  stage: string;
  state: StateService;
  force?: boolean;
}) =>
  Effect.gen(function* () {
    yield* annotateAccountHash();
    // deploy it with local state (which we will then hoist into the Cloudflare state store)
    const stateLayer = Layer.succeed(State, Effect.succeed(state));
    const { url, authToken } = yield* deploy({
      // use the script name as the stage name (so the user can have multiple state stores)
      stage,
      force,
      stack: Alchemy.Stack(
        "CloudflareStateStore",
        {
          providers: Cloudflare.providers(),
          state: stateLayer,
        },
        Effect.gen(function* () {
          const token = yield* TokenValue;
          const api = yield* Api;
          yield* AuthToken; // make sure it's in the Secrets Store

          // Surface the bearer token so tests and clients can authenticate
          // after deploy. The underlying value lives in the Cloudflare
          // Secrets Store; this output carries the same generated string.
          return {
            url: api.url.as<string>(),
            authToken: token.text.pipe(Output.map(Redacted.value)),
          };
        }),
      ),
    }).pipe(
      // The Cloudflare State Store is account-level infrastructure that
      // outlives any single deploy: its underlying Secrets Store and
      // auth-token secret may already exist from a previous (possibly
      // partially-failed) bootstrap. Opt in to adoption so the
      // resources reconcile in place instead of failing on conflict.
      adopt(true),
      // TODO(sam): we should not need to do this, but types do complain. fix deploy
      Effect.provide(stateLayer),
    );

    yield* writeCredentials(url, authToken);

    // Cloudflare's worker upload is eventually consistent: the deploy
    // call returns as soon as the script upload is accepted, but the
    // edge can keep serving the previous version for several seconds
    // afterwards. Block here until `/version` reports the version this
    // CLI was built against — otherwise downstream steps (syncing
    // local state into the deployed store, version probes during
    // adoption) end up talking to the old worker and may either
    // observe stale data or trip the staleness check and recurse into
    // another redeploy.
    yield* waitForStateStoreVersion(url);
    return { url, authToken };
  }).pipe(
    Effect.withSpan("state_store.deploy", {
      attributes: {
        "alchemy.state_store.op": "deploy",
      },
    }),
    recordStateStoreOp("deploy"),
  );

const deployWithLocalState = ({
  scriptName,
  isCI,
  force,
  profileName,
}: {
  scriptName: string;
  isCI: boolean;
  force: boolean;
  profileName: string;
}) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    const localStage = `${profileName}_${scriptName}`;
    const remoteStage = scriptName;
    const { authToken } = yield* deployStateStore({
      stage: localStage,
      state: localState,
      force,
    });

    const { url } = yield* loginWithCloudflare(profileName, force);
    const httpState = yield* makeCloudflareStateStore({ url, authToken });

    yield* hoistBootstrapStack({
      source: {
        state: localState,
        stage: localStage,
      },
      destination: {
        state: httpState,
        stage: remoteStage,
      },
    });

    yield* localState.deleteStack({
      stack: "CloudflareStateStore",
      stage: localStage,
    });

    return httpState;
  }).pipe(
    Effect.withSpan("state_store.finish_bootstrap", {
      attributes: {
        "alchemy.state_store.op": "finish_bootstrap",
        "alchemy.state_store.ci": isCI,
      },
    }),
  );

// check if there's a local stack that wasn't properly hoisted
const hasLocalStack = (stage: string) =>
  Effect.gen(function* () {
    const localState = yield* makeLocalState();
    return yield* Effect.map(
      localState.listStages("CloudflareStateStore"),
      // key off the profile name to avoid conflicts with other profiles
      (stages) => stages.includes(stage),
    );
  });

/**
 * Non-destructively copy every resource in the
 * `CloudflareStateStore/<scriptName>` stack from `source` into
 * `destination`, leaving every other stack in `destination` untouched.
 *
 * This intentionally does not delete anything from `destination`: at
 * bootstrap time the destination is the user's live remote state
 * store, and removing entries that happen to be missing locally would
 * be catastrophic.
 */
const hoistBootstrapStack = Effect.fnUntraced(function* ({
  source,
  destination,
}: {
  source: {
    state: StateService;
    stage: string;
  };
  destination: {
    state: StateService;
    stage: string;
  };
}) {
  const stack = "CloudflareStateStore";
  const fqns = yield* source.state.list({ stack, stage: source.stage });
  yield* Effect.annotateCurrentSpan({
    "alchemy.state_store.stack": stack,
    "alchemy.state_store.stage": source.stage,
    "alchemy.state_store.resources.count": fqns.length,
  });
  yield* Effect.forEach(
    fqns,
    Effect.fnUntraced(function* (fqn) {
      const value = yield* source.state.get({
        stack,
        stage: source.stage,
        fqn,
      });
      if (value) {
        yield* destination.state
          .set({
            stack,
            stage: destination.stage,
            fqn,
            value,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                isHttpClientError(error.cause) &&
                // worker can 404 for a bit on first deploy, retry these
                error.cause.response?.status === 404,
              schedule: Schedule.fixed(200),
            }),
          );
      }
    }),
    { concurrency: "unbounded" },
  );
}, Effect.withSpan("state_store.hoist_bootstrap_stack"));

/**
 * Log in to a Cloudflare-deployed HTTP state-store.
 *
 * 1. Find the single account-wide Secrets Store.
 * 2. Upload a short-lived edge-preview worker that binds the
 *    auth-token secret and returns its value.
 * 3. Derive the state-store worker URL from
 *    {@link STATE_STORE_SCRIPT_NAME} and the account's workers.dev
 *    subdomain.
 * 4. Persist `{ url, token }` under the `http-state-store`
 *    credentials file.
 *
 * Requirements are covered by the Cloudflare provider stack —
 * `CloudflareEnvironment`, `Credentials`, `HttpClient`, and
 * `FileSystem`.
 */
export const loginWithCloudflare = (profileName: string, force: boolean) =>
  Effect.gen(function* () {
    const credStore = yield* CredentialsStore;
    const isCI = yield* CI;
    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;

    if (!force) {
      // try and read from the cached credentials first if not forcing (force will always refresh)
      const credentials = yield* credStore.read<HttpStateStoreCredentials>(
        profileName,
        CREDENTIALS_FILE,
      );
      if (credentials) {
        return credentials;
      }
    }

    // 1. Locate the single Secrets Store on the account.
    const stores = yield* SecretsStore.listStores({ accountId });
    const store = stores.result[0];
    if (!store) {
      return yield* Effect.fail(
        new AuthError({
          message:
            "No Secrets Store found on this account. Deploy the state store first.",
        }),
      );
    }

    // 2. Fetch the auth-token from Secrets Store with a temporary edge-preview worker
    const authToken = yield* readSecretViaEdge(
      STATE_STORE_SCRIPT_NAME,
      store.id,
      AuthTokenSecretName,
    ).pipe(
      Effect.retry({
        while: isWorkersPreviewConfigurationError,
        schedule: Schedule.exponential(200).pipe(
          Schedule.both(Schedule.recurs(15)),
        ),
      }),
    );

    // 3. Derive the deployed worker URL.
    const { subdomain } = yield* workers.getSubdomain({ accountId });
    const url = `https://${STATE_STORE_SCRIPT_NAME}.${subdomain}.workers.dev`;

    if (!isCI) {
      // 4. Persist credentials. The profile entry is managed by
      //    `loadOrConfigure` when this is invoked through `configure`.
      yield* credStore
        .write<HttpStateStoreCredentials>(profileName, CREDENTIALS_FILE, {
          url,
          authToken: authToken.trim(),
        })
        .pipe(
          Effect.mapError(
            (e) =>
              new AuthError({
                message: "Failed to write credentials",
                cause: e,
              }),
          ),
        );

      yield* Clank.success(
        `HTTP state store credentials saved for '${profileName}'.`,
      );
      yield* Clank.info(`  url:     ${url}`);
    }

    return {
      url,
      authToken: authToken.trim(),
    };
  }).pipe(
    Effect.catchTag("EdgeSessionError", (e) =>
      Effect.fail(
        new AuthError({
          message: `Edge-preview secret read failed: ${e.message}`,
          cause: e.cause,
        }),
      ),
    ),
    Effect.withSpan("state_store.login", {
      attributes: {
        "alchemy.state_store.op": "login",
        "alchemy.state_store.script_name": STATE_STORE_SCRIPT_NAME,
      },
    }),
  );

const isStateStoreAvailable = (scriptName: string = "alchemy-state-store") =>
  Effect.gen(function* () {
    // otherwise, the remote one might exist
    const { accountId } = yield* CloudflareEnvironment.CloudflareEnvironment;
    return yield* workers.getScriptSetting({ accountId, scriptName }).pipe(
      Effect.map((setting) => setting !== undefined),
      Effect.catchTag("WorkerNotFound", () => Effect.succeed(false)),
    );
  });

const makeCloudflareStateStore = Effect.fnUntraced(function* ({
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

class StateStoreVersionNotReady extends Error {
  readonly _tag = "StateStoreVersionNotReady";
  constructor(
    readonly expected: number,
    readonly observed: number | undefined,
  ) {
    super(
      `Cloudflare State Store version not ready (expected v${expected}, observed v${observed ?? "unknown"}).`,
    );
  }
}

const waitForStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const { matches, expected, observed } = yield* checkStateStoreVersion(url);
    if (!matches) {
      return yield* Effect.fail(
        new StateStoreVersionNotReady(expected, observed),
      );
    }
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof StateStoreVersionNotReady,
      // Edge propagation is usually sub-second; poll fast and cap the
      // overall wait at ~10s so we fail loudly if something is really
      // wrong rather than silently hanging.
      schedule: Schedule.spaced("200 millis").pipe(
        Schedule.both(Schedule.recurs(50)),
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

const checkStateStoreVersion = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpApiClient.make(StateApi, { baseUrl: url });
    const isAvailable = yield* Effect.cached(
      isStateStoreAvailable(STATE_STORE_SCRIPT_NAME),
    );
    // The /version route may 404 transiently after a fresh deploy
    // while Cloudflare propagates the new script to the edge, and may
    // also surface transport-level blips on cold workers.dev hosts.
    // Retry the probe itself for ~10s before giving up — only after
    // exhausting that budget do we collapse to `undefined` and let
    // the caller treat it as a version mismatch.
    const result = yield* client.version.getVersion().pipe(
      Effect.catchTag("HttpClientError", (e) =>
        // if we get a 404 here, it means we assumed the worker shoudl exist, but it does not
        // we should do a check to see if it does
        e.response?.status === 404
          ? isAvailable.pipe(
              Effect.flatMap((isAvailable) =>
                // if the worker is available, then we should assume it was recently created and retry by propagating the error
                // otherwise, return undefined (we don't know the version, there is no worker)
                isAvailable ? Effect.fail(e) : Effect.succeed(undefined),
              ),
            )
          : Effect.fail(e),
      ),
      Effect.retry({
        schedule: Schedule.spaced("250 millis").pipe(
          Schedule.both(Schedule.recurs(40)),
        ),
      }),
      Effect.catch(() => Effect.succeed(undefined)),
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
  }).pipe(
    Effect.withSpan("state_store.check_version", {
      attributes: { "alchemy.state_store.op": "check_version" },
    }),
  );

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
  scriptName: string,
  storeId: string,
  secretName: string,
) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const file = new File([SECRET_PROBE_SOURCE], "worker.js", {
      type: "application/javascript+module",
    });
    const session = yield* createEdgeSession({
      scriptName,
      files: [file],
      bindings: [
        { type: "secrets_store_secret", name: "SECRET", secretName, storeId },
      ],
    });
    const response = yield* http.get(session.url, {
      headers: session.headers,
    });
    if (response.status !== 200) {
      const body = yield* response.text.pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      // TEMP(sam): dump the full body so we can capture the exact
      // Cloudflare error page when the probe fails in the wild. Drop
      // this once we've confirmed the routing fix covers all the
      // observed failure modes.
      yield* Effect.logWarning(
        `Secret probe failed (${response.status}) at ${session.url}\n${body}`,
      );
      return yield* Effect.fail(
        new EdgeSessionError({
          message: `Secret probe returned ${response.status}: ${body.slice(0, 200)}`,
        }),
      );
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

const writeCredentials = (url: string, authToken: string) =>
  Effect.gen(function* () {
    const profileName = yield* ALCHEMY_PROFILE;
    const credStore = yield* CredentialsStore;
    yield* credStore.write<HttpStateStoreCredentials>(
      profileName,
      CREDENTIALS_FILE,
      {
        url,
        authToken,
      },
    );
  });

const isWorkersPreviewConfigurationError = (error: unknown) =>
  error instanceof EdgeSessionError &&
  (error.message.includes("Invalid Workers Preview configuration") ||
    error.message.includes("Error 1031"));

/**
 * SHA-256 hex digest of the Cloudflare account ID. Used as a stable
 * pseudonymous identifier on telemetry spans so the dashboard can
 * count distinct state-store deployments without leaking the raw
 * accountId. Mirrors the `alchemy.git.origin_hash` pattern in
 * `Telemetry/Attributes.ts`.
 */
const hashAccountId = (accountId: string) =>
  Effect.sync(() =>
    crypto.createHash("sha256").update(accountId).digest("hex"),
  );

/**
 * Best-effort Cloudflare-account-hash annotation on the current span.
 * Resolves the accountId from {@link CloudflareEnvironment} and
 * attaches `alchemy.cloudflare.account_hash` to whichever span is
 * active. Silently no-ops if the environment isn't resolvable so
 * State-store layer construction still succeeds in degraded paths.
 *
 * `noTrack` controls whether the hash is attached:
 *   - `true`  — never annotate (caller-level opt-out).
 *   - `false` — always annotate, regardless of env.
 *   - `undefined` — fall back to the `NO_TRACK` env var; default off.
 */
const annotateAccountHash = (noTrack?: boolean) =>
  Effect.gen(function* () {
    if (noTrack === true) return;
    if (noTrack === undefined) {
      const fromEnv = yield* Config.boolean("NO_TRACK").pipe(
        Config.withDefault(false),
      );
      if (fromEnv) return;
    }
    const env = yield* Effect.serviceOption(
      CloudflareEnvironment.CloudflareEnvironment,
    );
    if (env._tag !== "Some") return;
    const hash = yield* hashAccountId(env.value.accountId);
    yield* Effect.annotateCurrentSpan("alchemy.cloudflare.account_hash", hash);
  }).pipe(Effect.catch(() => Effect.void));
