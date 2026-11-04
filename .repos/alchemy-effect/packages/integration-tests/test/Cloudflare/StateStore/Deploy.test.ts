import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { STATE_STORE_VERSION } from "@alchemy.run/cloudflare/StateStore/Api";
import {
  bootstrap,
  loginWithCloudflare,
  teardownStateStore,
} from "@alchemy.run/cloudflare/StateStore/State";
import {
  AuthTokenSecretName,
  EncryptionKeySecretName,
  stateStoreSecretName,
} from "@alchemy.run/cloudflare/StateStore/Token";
import { findZoneByName } from "@alchemy.run/cloudflare/Zone/lookup";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Alchemist from "alchemy/Alchemist";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { currentProfileName } from "alchemy/Auth/Profile";
import { checkHttpStateStoreAuth, makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { makeLocalState } from "alchemy/State/LocalState";
import { State } from "alchemy/State/State";
import { exec } from "alchemy/Util/exec";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { testName } from "../../names.ts";
import { workerName as configuredWorkerName } from "./fixtures/configured-store.ts";

/**
 * Every way a Cloudflare State Store deploy can start, and what it must keep.
 * Whatever the starting point, a deploy never changes a secret that exists:
 * replacing the auth token or the encryption key loses every stack's state.
 * Each case checks the secrets' ids and modification times out of band.
 */

const { test } = Test.make({ providers: Cloudflare.providers() });

const tags = ["provider:cloudflare", "provider:cloudflare:statestore", "live"];
const stage = Test.defaultStage().replaceAll("_", "-");
/** A store Worker name, unique per stage and short enough for previews (54). */
const storeWorker = (name: string) => testName(`alchemy-state-store-${name}`);
/** A store name for the old release's `--name`, which allows 20 characters: unique per stage. */
const storeName = (prefix: string) =>
  `${prefix}-${crypto.createHash("sha256").update(stage).digest("hex").slice(0, 8)}`;

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

const record = (fqn: string) => ({
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn,
  instanceId: "kept",
  providerVersion: 1,
  status: "created" as const,
  downstream: [],
  bindings: [],
  props: { hello: "world" },
  attr: { id: "kept" },
});

/** Open a store the way a stack does, building its layer anew. */
const open = (options: Cloudflare.CloudflareStateOptions) =>
  State.pipe(Effect.flatten, Effect.provide(Layer.fresh(Cloudflare.state(options))));

/** A store's secrets by name: every match, so a duplicate shows up too. */
const observeSecrets = (accountId: string, workerName: string) =>
  Effect.gen(function* () {
    const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
    if (Option.isNone(store)) return { token: [], key: [] };
    const secrets = Array.from(
      yield* secretsStore.listStoreSecrets
        .items({ accountId, storeId: store.value.id })
        .pipe(Stream.runCollect),
    );
    const named = (base: string) =>
      secrets
        .filter((secret) => secret.name === stateStoreSecretName(base, workerName))
        .map((secret) => ({ id: secret.id, modified: secret.modified }));
    return { token: named(AuthTokenSecretName), key: named(EncryptionKeySecretName) };
  });

const deleteSecret = (accountId: string, workerName: string, base: string) =>
  Effect.gen(function* () {
    const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
    if (Option.isNone(store)) return;
    const secret = yield* secretsStore.listStoreSecrets
      .items({ accountId, storeId: store.value.id })
      .pipe(
        Stream.filter((secret) => secret.name === stateStoreSecretName(base, workerName)),
        Stream.runHead,
      );
    if (Option.isSome(secret)) {
      yield* secretsStore.deleteStoreSecret({
        accountId,
        storeId: store.value.id,
        secretId: secret.value.id,
      });
    }
  });

/** When the Worker's script was last uploaded, or `undefined` without one. */
const scriptModifiedOn = (accountId: string, workerName: string) =>
  workers.listScripts.items({ accountId }).pipe(
    Stream.filter((script) => script.id === workerName),
    Stream.runHead,
    Effect.map((script) => (Option.isSome(script) ? script.value.modifiedOn : undefined)),
  );

const scriptExists = (accountId: string, workerName: string) =>
  Effect.map(scriptModifiedOn(accountId, workerName), (modified) => modified !== undefined);

/** The version a store's Worker reports. */
const servedVersion = (url: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(`${url}/version`);
    return ((yield* response.json) as { version: number }).version;
  });

/** The version a store's Worker reports once the edge serves `version`. */
const eventuallyServes = (url: string, version: number) =>
  servedVersion(url).pipe(
    Effect.repeat({
      until: (served) => served === version,
      schedule: Schedule.spaced("1 second"),
      times: 30,
    }),
  );

const attachedDomains = (accountId: string, hostname: string) =>
  workers
    .listDomains({ accountId, hostname })
    .pipe(
      Effect.map(({ result }) =>
        (result ?? []).filter((d) => d.hostname === hostname).map((d) => d.service),
      ),
    );

const expectFailure = <A, E>(exit: Exit.Exit<A, E>, message: string) => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(message);
};

test.provider(
  "a store named by workerName deploys once, then adopts and redeploys without touching its secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("deploy");
      yield* teardownStateStore({ workerName });

      // First use deploys the Worker under exactly `workerName`, with one
      // token and one key named after it.
      const state = yield* open({ workerName });
      yield* state.set({ stack: "deploy", stage: "test", fqn: "a", value: record("a") });
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.token).toHaveLength(1);
      expect(secrets.key).toHaveLength(1);
      const suffix = workerName.replaceAll("-", "_");
      expect(stateStoreSecretName(AuthTokenSecretName, workerName)).toBe(
        `AlchemyStateStoreToken_${suffix}`,
      );
      expect(stateStoreSecretName(EncryptionKeySecretName, workerName)).toBe(
        `AlchemyStateStoreEncryptionKey_${suffix}`,
      );
      const uploaded = yield* scriptModifiedOn(accountId, workerName);
      expect(uploaded).toBeDefined();

      // Opening it again adopts it as it is.
      const reopened = yield* open({ workerName });
      expect(yield* reopened.get({ stack: "deploy", stage: "test", fqn: "a" })).toEqual(
        record("a"),
      );
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);

      // So does a bootstrap, which refreshes the credentials.
      const adopted = yield* bootstrap({ workerName });
      expect(yield* adopted.get({ stack: "deploy", stage: "test", fqn: "a" })).toEqual(record("a"));
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);

      // A forced redeploy uploads the Worker again over the same secrets.
      const redeployed = yield* bootstrap({ workerName, force: true });
      expect(yield* scriptModifiedOn(accountId, workerName)).not.toEqual(uploaded);
      expect(yield* redeployed.get({ stack: "deploy", stage: "test", fqn: "a" })).toEqual(
        record("a"),
      );
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);

      yield* teardownStateStore({ workerName });
      expect(yield* scriptExists(accountId, workerName)).toBe(false);
      expect(yield* observeSecrets(accountId, workerName)).toEqual({ token: [], key: [] });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a Worker name workers.dev can't serve fails before anything is created",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // The store enables workers.dev previews, and Cloudflare rejects a
      // script name over 54 characters with previews enabled.
      const workerName = `${storeWorker("too-long")}-`.padEnd(55, "x");
      const message = `Invalid Cloudflare State Store Worker name '${workerName}'`;
      expectFailure(yield* Effect.exit(open({ workerName })), message);
      expectFailure(yield* Effect.exit(bootstrap({ workerName })), message);
      expect(yield* scriptExists(accountId, workerName)).toBe(false);
      expect(yield* observeSecrets(accountId, workerName)).toEqual({ token: [], key: [] });
    }),
  { tags, timeout: 60_000 },
);

test.provider(
  "a store a newer Alchemy deployed is left untouched",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("newer");
      yield* stack.destroy();
      yield* teardownStateStore({ workerName });

      // Stands in for a store from a future release: it serves a later version.
      yield* stack.deploy(
        Cloudflare.Worker("NewerStore", {
          name: workerName,
          script: `export default { fetch() { return Response.json({ version: ${STATE_STORE_VERSION + 1} }); } };`,
          workersDev: true,
        }),
      );
      const uploaded = yield* scriptModifiedOn(accountId, workerName);

      const message = `runs v${STATE_STORE_VERSION + 1}, newer than this Alchemy's v${STATE_STORE_VERSION}`;
      expectFailure(yield* Effect.exit(open({ workerName })), message);
      expectFailure(yield* Effect.exit(bootstrap({ workerName })), message);
      expectFailure(yield* Effect.exit(bootstrap({ workerName, force: true })), message);
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);
      expect(yield* observeSecrets(accountId, workerName)).toEqual({ token: [], key: [] });

      yield* stack.destroy();
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a store whose Worker is gone is redeployed onto its existing secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("orphaned");
      yield* teardownStateStore({ workerName });

      yield* open({ workerName });
      const secrets = yield* observeSecrets(accountId, workerName);
      const profile = yield* currentProfileName;
      const credentials = yield* loginWithCloudflare(profile, true, workerName, accountId);

      // The Worker is deleted, as after an interrupted teardown, and bootstrap
      // runs at once, while the edge can still answer for the deleted Worker.
      // Each round must redeploy rather than adopt a store that isn't there.
      for (const round of [1, 2, 3]) {
        yield* workers.deleteScript({ accountId, scriptName: workerName, force: true });
        const redeployed = yield* bootstrap({ workerName });
        expect(yield* scriptExists(accountId, workerName)).toBe(true);
        yield* redeployed.set({
          stack: "orphaned",
          stage: "test",
          fqn: `round-${round}`,
          value: record(`round-${round}`),
        });
        expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
        // The token from before still authenticates.
        expect(yield* checkHttpStateStoreAuth(credentials)).toBe(true);
      }

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 400_000 },
);

test.provider(
  "a store missing its auth token gets a new one and keeps its encryption key and state",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("no-token");
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "no-token", stage: "test", fqn: "a", value: record("a") });
      const { key } = yield* observeSecrets(accountId, workerName);

      yield* deleteSecret(accountId, workerName, AuthTokenSecretName);

      const healed = yield* bootstrap({ workerName });
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.token).toHaveLength(1);
      expect(secrets.key).toEqual(key);
      expect(yield* healed.get({ stack: "no-token", stage: "test", fqn: "a" })).toEqual(
        record("a"),
      );

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a store that lost its encryption key gets a new one only when approved",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("no-key");
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "no-key", stage: "test", fqn: "a", value: record("a") });
      const { token } = yield* observeSecrets(accountId, workerName);

      yield* deleteSecret(accountId, workerName, EncryptionKeySecretName);
      const uploaded = yield* scriptModifiedOn(accountId, workerName);

      // The store held state under the lost key: with nobody to confirm,
      // nothing changes.
      expectFailure(
        yield* Effect.exit(bootstrap({ workerName })),
        `Cloudflare State Store '${workerName}' has lost its encryption key`,
      );
      expect(yield* observeSecrets(accountId, workerName)).toEqual({ token, key: [] });
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);

      // `force` approves a new key; the token is kept.
      const restarted = yield* bootstrap({ workerName, force: true });
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.key).toHaveLength(1);
      expect(secrets.token).toEqual(token);
      yield* restarted.set({ stack: "no-key", stage: "test", fqn: "b", value: record("b") });
      expect(yield* restarted.get({ stack: "no-key", stage: "test", fqn: "b" })).toEqual(
        record("b"),
      );

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "concurrent first deploys of one store create a single pair of secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("concurrent");
      yield* teardownStateStore({ workerName });

      const [first, second] = yield* Effect.all(
        [bootstrap({ workerName }), bootstrap({ workerName })],
        { concurrency: 2 },
      );
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.token).toHaveLength(1);
      expect(secrets.key).toHaveLength(1);

      // Both hold working credentials for the same store.
      yield* first.set({ stack: "concurrent", stage: "test", fqn: "a", value: record("a") });
      expect(yield* second.get({ stack: "concurrent", stage: "test", fqn: "a" })).toEqual(
        record("a"),
      );

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a store whose name differs from another's only by '-' and '_' is refused, and tearing it down keeps the other's secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("shared");
      const lookalike = workerName.replaceAll("-", "_");
      yield* teardownStateStore({ workerName: lookalike });
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "shared", stage: "test", fqn: "a", value: record("a") });
      const secrets = yield* observeSecrets(accountId, workerName);

      const refused = yield* Effect.exit(bootstrap({ workerName: lookalike }));
      expectFailure(refused, `its secrets would be shared with Worker '${workerName}'`);
      expect(yield* scriptExists(accountId, lookalike)).toBe(false);

      yield* teardownStateStore({ workerName: lookalike });
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      const kept = yield* bootstrap({ workerName });
      expect(yield* kept.get({ stack: "shared", stage: "test", fqn: "a" })).toEqual(record("a"));

      yield* teardownStateStore({ workerName });
      expect(yield* observeSecrets(accountId, workerName)).toEqual({ token: [], key: [] });
    }),
  { tags, timeout: 300_000 },
);

test.provider(
  "a domain another Worker owns fails before changing anything, and a free one attaches to the existing store",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("domain");
      const domain = `state-taken-${stage}.${ZONE}`;
      yield* stack.destroy();
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "domain", stage: "test", fqn: "a", value: record("a") });
      const secrets = yield* observeSecrets(accountId, workerName);
      const uploaded = yield* scriptModifiedOn(accountId, workerName);

      const holder = yield* stack.deploy(
        Cloudflare.Worker("DomainHolder", {
          script: `export default { fetch() { return new Response("holder"); } };`,
          domain,
        }),
      );
      const taken = yield* Effect.exit(bootstrap({ workerName, domain }));
      expectFailure(taken, `already attached to Worker '${holder.workerName}'`);
      expect(yield* attachedDomains(accountId, domain)).toEqual([holder.workerName]);
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);

      // Once the hostname is free, the existing store moves onto it.
      yield* stack.destroy();
      const moved = yield* bootstrap({ workerName, domain });
      expect(yield* attachedDomains(accountId, domain)).toEqual([workerName]);
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      expect(yield* moved.get({ stack: "domain", stage: "test", fqn: "a" })).toEqual(record("a"));

      yield* teardownStateStore({ workerName });
      expect(yield* attachedDomains(accountId, domain)).toEqual([]);
    }),
  { tags, timeout: 400_000 },
);

test.provider(
  "a store that can't be reached after a deploy fails within 2 minutes and keeps its secrets and state",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = storeWorker("blocked");
      const domain = `state-blocked-${stage}.${ZONE}`;
      yield* stack.destroy();
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "blocked", stage: "test", fqn: "a", value: record("a") });
      const secrets = yield* observeSecrets(accountId, workerName);

      // Only an address nobody uses may reach the store's hostname, so every
      // request to it is refused once the store moves there.
      const zone = yield* findZoneByName({ accountId, name: ZONE });
      expect(zone).toBeDefined();
      yield* stack.deploy(
        Cloudflare.Firewall.Lockdown("BlockStore", {
          zoneId: zone!.id,
          urls: [`${domain}/*`],
          configurations: [{ target: "ip", value: "192.0.2.1" }],
          description: "alchemy state store test: unreachable store",
        }),
      );

      const started = yield* Clock.currentTimeMillis;
      expectFailure(
        yield* Effect.exit(bootstrap({ workerName, domain })),
        `did not serve v${STATE_STORE_VERSION} within 2 minutes`,
      );
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(200_000);
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      // Its state is still there on workers.dev.
      const kept = yield* bootstrap({ workerName });
      expect(yield* kept.get({ stack: "blocked", stage: "test", fqn: "a" })).toEqual(record("a"));

      yield* stack.destroy();
      yield* teardownStateStore({ workerName });
      expect(yield* attachedDomains(accountId, domain)).toEqual([]);
    }),
  { tags, timeout: 400_000 },
);

/** Run with `CI` and the given env set, as a CI deploy would. */
const inCI = <A, E, R>(env: Readonly<Record<string, string>>, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const vars = { CI: "true", ...env };
      const previous = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
      Object.assign(process.env, vars);
      return previous;
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }),
  );

test.provider(
  "in CI, `alchemy state bootstrap` deploys the store the config names",
  () =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      const { accountId } = environment;
      const workerName = configuredWorkerName;
      const entrypoint = fileURLToPath(new URL("./fixtures/configured-store.ts", import.meta.url));
      const source = { type: "configured", entrypoint } as const;
      const alchemist = Alchemist.layer();
      yield* teardownStateStore({ workerName });

      expect(environment.type).toBe("apiToken");
      const env: Record<string, string> =
        environment.type === "apiToken"
          ? {
              CLOUDFLARE_API_TOKEN: Redacted.value(environment.apiToken),
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          : {};

      // A CI run of the stack can't deploy it, and names the command that can:
      // `--name` is the store's full Worker name.
      const missing = yield* inCI(
        env,
        Effect.exit(Alchemist.State.store(source).pipe(Effect.provide(alchemist))),
      );
      expectFailure(
        missing,
        `Run 'alchemy state bootstrap --backend cloudflare --name ${workerName} --profile`,
      );
      expect(yield* scriptExists(accountId, workerName)).toBe(false);

      const { version } = yield* inCI(
        env,
        Alchemist.State.bootstrapConfigured(source).pipe(Effect.provide(alchemist)),
      );
      expect(version).toBe(STATE_STORE_VERSION);
      expect(yield* scriptExists(accountId, workerName)).toBe(true);
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.token).toHaveLength(1);
      expect(secrets.key).toHaveLength(1);

      yield* teardownStateStore({ workerName });
    }),
  // Exclusive: sets `CI` on the process.
  { tags, timeout: 300_000, exclusive: true },
);

/**
 * The last release before this store's direct deploy: it deploys the store
 * through a `CloudflareStateStore` stack, and redeploys any store whose
 * version differs from its own.
 */
const OLD_ALCHEMY = "2.0.0-beta.84";
/** The store version that release deploys. */
const OLD_STATE_STORE_VERSION = 7;

const oldAlchemyDir = fileURLToPath(
  new URL(`../../../.alchemy/old-alchemy/${OLD_ALCHEMY}/`, import.meta.url),
);

/** Install the old release once, into a directory of its own. */
const installOldAlchemy = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cli = path.join(oldAlchemyDir, "node_modules", "alchemy", "bin", "cli.js");
  if (yield* fs.exists(cli)) return cli;
  yield* fs.makeDirectory(oldAlchemyDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(oldAlchemyDir, "package.json"),
    JSON.stringify({ name: "old-alchemy", private: true, type: "module" }),
  );
  const { exitCode, stderr } = yield* exec(
    ChildProcess.make(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        `alchemy@${OLD_ALCHEMY}`,
        `@alchemy.run/cloudflare@${OLD_ALCHEMY}`,
        "effect@4.0.7",
        "@effect/platform-node@4.0.7",
        // platform-node asks for `^4.0.7`, and 4.1 needs effect 4.1.
        "@effect/platform-node-shared@4.0.7",
        "@effect/platform-bun@4.0.7",
      ],
      { cwd: oldAlchemyDir, stdout: "pipe", stderr: "pipe" },
    ),
  );
  expect({ exitCode, stderr: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" });
  return cli;
}).pipe(Effect.scoped);

const oldAlchemyCli = Effect.runSync(Effect.cached(installOldAlchemy));

/** `alchemy state bootstrap --backend cloudflare --name <name>` from the old release. */
const oldBootstrap = (name: string) =>
  Effect.gen(function* () {
    const environment = yield* yield* CloudflareEnvironment;
    if (environment.type !== "apiToken") {
      return yield* Effect.die(new Error("The old CLI needs an API token."));
    }
    const cli = yield* oldAlchemyCli;
    const home = `${oldAlchemyDir}home-${name}`;
    return yield* exec(
      ChildProcess.make(
        "node",
        [cli, "state", "bootstrap", "--backend", "cloudflare", "--name", name, "--no-input"],
        {
          cwd: oldAlchemyDir,
          env: {
            HOME: home,
            ALCHEMY_PROFILE: "old-alchemy",
            CLOUDFLARE_API_TOKEN: Redacted.value(environment.apiToken),
            CLOUDFLARE_ACCOUNT_ID: environment.accountId,
          },
          extendEnv: true,
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
    ).pipe(Effect.scoped);
  }).pipe(Effect.provide(NodeServices.layer));

test.provider(
  "an older Alchemy can't redeploy a store this version deployed",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = storeName("new");
      const workerName = `alchemy-state-store-${name}`;
      yield* teardownStateStore({ workerName });

      const state = yield* open({ workerName });
      yield* state.set({ stack: "new", stage: "test", fqn: "a", value: record("a") });
      const secrets = yield* observeSecrets(accountId, workerName);
      const uploaded = yield* scriptModifiedOn(accountId, workerName);

      // It sees a version it doesn't know and redeploys through its bootstrap
      // stack, which the store refuses before any secret is touched.
      const old = yield* oldBootstrap(name);
      expect(old.exitCode).not.toBe(0);
      expect(`${old.stdout}${old.stderr}`).toContain("409");
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(uploaded);
      const kept = yield* bootstrap({ workerName });
      expect(yield* kept.get({ stack: "new", stage: "test", fqn: "a" })).toEqual(record("a"));

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 400_000 },
);

test.provider(
  "a store an older Alchemy deployed is upgraded in place with its secrets and state, and the old version can't take it back",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = storeName("old");
      const workerName = `alchemy-state-store-${name}`;
      yield* teardownStateStore({ workerName });

      const deployed = yield* oldBootstrap(name);
      expect({
        exitCode: deployed.exitCode,
        output: deployed.exitCode === 0 ? "" : deployed.stderr,
      }).toEqual({
        exitCode: 0,
        output: "",
      });
      const secrets = yield* observeSecrets(accountId, workerName);
      expect(secrets.token).toHaveLength(1);
      expect(secrets.key).toHaveLength(1);

      // State written to the old Worker.
      const profile = yield* currentProfileName;
      const credentials = yield* loginWithCloudflare(profile, true, workerName, accountId);
      expect(yield* servedVersion(credentials.url)).toBe(OLD_STATE_STORE_VERSION);
      const legacy = yield* makeHttpStateStore({ ...credentials, id: "legacy" });
      yield* legacy.set({ stack: "old", stage: "test", fqn: "a", value: record("a") });
      // The old version deployed the store through a stack recorded in it.
      expect([...(yield* legacy.listStacks())].sort()).toEqual(["CloudflareStateStore", "old"]);

      // An interrupted old bootstrap leaves that stack in local state, under
      // `<profile>_<worker>`. Another store's leftovers are its own business.
      const local = yield* makeLocalState();
      const leftover = { stack: "CloudflareStateStore", fqn: "StateStoreSecrets" };
      yield* local.set({ ...leftover, stage: `${profile}_${workerName}`, value: record("s") });
      yield* local.set({ ...leftover, stage: `${profile}_other-store`, value: record("s") });

      const upgraded = yield* bootstrap({ workerName });
      const upgradedOn = yield* scriptModifiedOn(accountId, workerName);
      // Stacks opening it right away, while edge locations may still serve
      // the old version, neither fail as out of date nor redeploy it.
      for (const _ of [1, 2, 3]) {
        const reopened = yield* open({ workerName });
        expect(yield* reopened.get({ stack: "old", stage: "test", fqn: "a" })).toEqual(record("a"));
      }
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(upgradedOn);
      // A redeploy reaches every edge location within seconds.
      expect(yield* eventuallyServes(credentials.url, STATE_STORE_VERSION)).toBe(
        STATE_STORE_VERSION,
      );
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      expect(yield* upgraded.get({ stack: "old", stage: "test", fqn: "a" })).toEqual(record("a"));
      // The upgrade deletes that stack's records, so nobody can destroy the
      // store through them.
      expect(yield* upgraded.listStacks()).toEqual(["old"]);
      expect(yield* local.listStages("CloudflareStateStore")).toEqual([`${profile}_other-store`]);
      yield* local.deleteStack({ stack: "CloudflareStateStore" });

      const old = yield* oldBootstrap(name);
      expect(old.exitCode).not.toBe(0);
      expect(`${old.stdout}${old.stderr}`).toContain("409");
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      expect(yield* scriptModifiedOn(accountId, workerName)).toEqual(upgradedOn);

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 600_000 },
);

test.provider(
  "a stack opening a store an older Alchemy deployed upgrades it in place only when approved",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = storeName("v7");
      const workerName = `alchemy-state-store-${name}`;
      yield* teardownStateStore({ workerName });

      const deployed = yield* oldBootstrap(name);
      expect({
        exitCode: deployed.exitCode,
        output: deployed.exitCode === 0 ? "" : deployed.stderr,
      }).toEqual({ exitCode: 0, output: "" });
      const secrets = yield* observeSecrets(accountId, workerName);
      const profile = yield* currentProfileName;
      const credentials = yield* loginWithCloudflare(profile, true, workerName, accountId);
      expect(yield* servedVersion(credentials.url)).toBe(OLD_STATE_STORE_VERSION);
      const legacy = yield* makeHttpStateStore({ ...credentials, id: "legacy" });
      yield* legacy.set({ stack: "v7", stage: "test", fqn: "a", value: record("a") });

      // Without `--yes` (and nobody to confirm), the deploy stops and says so.
      const unapproved = yield* Effect.exit(open({ workerName }));
      expectFailure(
        unapproved,
        `is out of date (expected v${STATE_STORE_VERSION}, observed v${OLD_STATE_STORE_VERSION})`,
      );
      expect(yield* servedVersion(credentials.url)).toBe(OLD_STATE_STORE_VERSION);
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);

      // With `--yes`, it upgrades the store in place.
      const context = yield* Effect.serviceOption(AlchemyContext);
      const upgraded = yield* open({ workerName }).pipe(
        Effect.provideService(AlchemyContext, {
          dotAlchemy: Option.isSome(context) ? context.value.dotAlchemy : ".alchemy",
          dev: false,
          adopt: false,
          updateStateStore: true,
        }),
      );
      expect(yield* eventuallyServes(credentials.url, STATE_STORE_VERSION)).toBe(
        STATE_STORE_VERSION,
      );
      expect(yield* observeSecrets(accountId, workerName)).toEqual(secrets);
      expect(yield* upgraded.get({ stack: "v7", stage: "test", fqn: "a" })).toEqual(record("a"));
      expect(yield* upgraded.listStacks()).toEqual(["v7"]);

      yield* teardownStateStore({ workerName });
    }),
  { tags, timeout: 600_000 },
);
