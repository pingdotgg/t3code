import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
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
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Alchemist from "alchemy/Alchemist";
import { currentProfileName } from "alchemy/Auth/Profile";
import { checkHttpStateStoreAuth } from "alchemy/State/HttpStateStore";
import { State } from "alchemy/State/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

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

const scriptExists = (accountId: string, scriptName: string) =>
  workers.getScriptSetting({ accountId, scriptName }).pipe(
    Effect.as(true),
    Effect.catchTag(["WorkerNotFound", "InvalidRoute", "WorkerHasNoVersions"], () =>
      Effect.succeed(false),
    ),
  );

test.provider(
  "a named Cloudflare state store bootstraps, serves state and tears down beside the default",
  (stack) =>
    Effect.gen(function* () {
      const environment = yield* yield* CloudflareEnvironment;
      const { accountId } = environment;
      // Never the default store, which every other run on the account uses.
      const worker = "alchemy-state-store-lifecycle";
      // `--name` is the store's full Worker name.
      const target = { type: "provider", backend: "cloudflare", name: worker } as const;
      const alchemist = Alchemist.layer();
      const defaultStacks = () =>
        Effect.flatMap(
          Alchemist.State.store({ type: "provider", backend: "cloudflare" }).pipe(
            Effect.provide(alchemist),
          ),
          (store) => store.listStacks(),
        );

      const before = yield* defaultStacks();
      yield* stack.destroy();
      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(yield* scriptExists(accountId, worker)).toBe(true);

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      // Opening the store from a profile with no cached credentials, with a
      // token that can't read Workers scripts, can't tell whether the store
      // exists. It fails instead of bootstrapping over the live store.
      const limited = yield* stack.deploy(
        Cloudflare.ApiToken.AccountApiToken("NoWorkersScriptsRead", {
          policies: [
            {
              effect: "allow",
              permissionGroups: ["Account Settings Read"],
              resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
            },
          ],
        }),
      );
      const unknown = `Could not determine whether Cloudflare State Store '${worker}' exists, so it was left untouched`;
      const blind = yield* inCI(
        {
          CLOUDFLARE_API_TOKEN: Redacted.value(limited.value),
          CLOUDFLARE_ACCOUNT_ID: accountId,
          ALCHEMY_PROFILE: `${stack.stage}-no-scripts-read`,
        },
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      ).pipe(
        // A fresh token can take a few seconds to authenticate.
        Effect.repeat({
          until: (exit) => Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(unknown),
          schedule: Schedule.spaced("5 seconds"),
          times: 6,
        }),
      );
      expect(Exit.isFailure(blind)).toBe(true);
      if (Exit.isFailure(blind)) {
        expect(Cause.pretty(blind.cause)).toContain(unknown);
        expect(Cause.pretty(blind.cause)).toContain("Workers Scripts Read");
      }

      // The store is deployed without a stack, so a new one holds no state,
      // and it still serves with the credentials it had.
      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(torn.deleted).toEqual([worker]);
      expect(yield* scriptExists(accountId, worker)).toBe(false);

      // In CI, a missing store fails instead of being deployed on first use.
      // CI reads Cloudflare credentials from the environment only. The
      // deleted Worker's workers.dev URL can keep serving for a few seconds,
      // so retry until the edge reports it gone.
      expect(environment.type).toBe("apiToken");
      const expected = `Run 'alchemy state bootstrap --backend cloudflare --name ${worker}`;
      const inCi = yield* inCI(
        environment.type === "apiToken"
          ? {
              CLOUDFLARE_API_TOKEN: Redacted.value(environment.apiToken),
              CLOUDFLARE_ACCOUNT_ID: accountId,
            }
          : {},
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      ).pipe(
        Effect.repeat({
          until: (exit) => Exit.isFailure(exit) && Cause.pretty(exit.cause).includes(expected),
          schedule: Schedule.spaced("5 seconds"),
          times: 12,
        }),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) expect(Cause.pretty(inCi.cause)).toContain(expected);
      expect(yield* scriptExists(accountId, worker)).toBe(false);

      // The default store kept serving through all of it.
      expect(yield* scriptExists(accountId, "alchemy-state-store")).toBe(true);
      expect(yield* defaultStacks()).toEqual(before);
      yield* stack.destroy();
    }),
  // Exclusive: sets `CI` on the process.
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
    exclusive: true,
  },
);

/** The ids of a store's two secrets, observed out-of-band. */
const secretIds = (accountId: string, workerName: string) =>
  Effect.gen(function* () {
    const names = [
      stateStoreSecretName(AuthTokenSecretName, workerName),
      stateStoreSecretName(EncryptionKeySecretName, workerName),
    ];
    const store = yield* secretsStore.listStores.items({ accountId }).pipe(Stream.runHead);
    if (store._tag === "None") return [];
    const secrets = yield* secretsStore.listStoreSecrets
      .items({ accountId, storeId: store.value.id })
      .pipe(Stream.runCollect);
    return names.map((name) => Array.from(secrets).find((secret) => secret.name === name)?.id);
  });

test.provider(
  "a state store pinned to an account and named by workerName deploys there and keeps its secrets",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const workerName = `alchemy-state-store-pin-${Test.defaultStage().replaceAll("_", "-")}`;
      const record = {
        kind: "resource" as const,
        resourceType: "Test.Resource",
        namespace: undefined,
        fqn: "pinned/a",
        logicalId: "a",
        instanceId: "kept",
        providerVersion: 1,
        status: "created" as const,
        downstream: [],
        bindings: [],
        props: { hello: "world" },
        attr: { id: "kept" },
      };
      yield* teardownStateStore({ workerName, accountId });

      // An account the credentials can't reach fails instead of falling back
      // to the profile's account.
      const unreachable = yield* Effect.exit(
        State.pipe(
          Effect.flatten,
          Effect.provide(Cloudflare.state({ workerName, accountId: "0".repeat(32) })),
        ),
      );
      expect(Exit.isFailure(unreachable)).toBe(true);
      if (Exit.isFailure(unreachable)) {
        expect(Cause.pretty(unreachable.cause)).toContain(`pinned to account ${"0".repeat(32)}`);
      }
      expect(yield* scriptExists(accountId, workerName)).toBe(false);

      // The pinned account deploys the Worker under exactly `workerName`.
      const state = yield* State.pipe(
        Effect.flatten,
        Effect.provide(Cloudflare.state({ workerName, accountId })),
      );
      yield* state.set({ stack: "pinned", stage: "test", fqn: "pinned/a", value: record });
      expect(yield* scriptExists(accountId, workerName)).toBe(true);
      const secrets = yield* secretIds(accountId, workerName);
      expect(secrets.every((id) => id !== undefined)).toBe(true);

      // A forced redeploy reuses both secrets, so state written before it
      // still decrypts.
      const redeployed = yield* bootstrap({ workerName, accountId, force: true });
      expect(yield* secretIds(accountId, workerName)).toEqual(secrets);
      expect(yield* redeployed.get({ stack: "pinned", stage: "test", fqn: "pinned/a" })).toEqual(
        record,
      );

      yield* teardownStateStore({ workerName, accountId });
      expect(yield* scriptExists(accountId, workerName)).toBe(false);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
  },
);

const ZONE = process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

/** The Workers custom domains attached to `hostname`. */
const attachedDomains = (accountId: string, hostname: string) =>
  workers
    .listDomains({ accountId, hostname })
    .pipe(
      Effect.map(({ result }) =>
        (result ?? []).filter((d) => d.hostname === hostname).map((d) => d.service),
      ),
    );

test.provider(
  "a state store with a domain serves and logs in on it",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const stage = Test.defaultStage().replaceAll("_", "-");
      const workerName = `alchemy-state-store-domain-${stage}`;
      const domain = `state-${stage}.${ZONE}`;
      const record = {
        kind: "resource" as const,
        resourceType: "Test.Resource",
        namespace: undefined,
        fqn: "domain/a",
        logicalId: "a",
        instanceId: "kept",
        providerVersion: 1,
        status: "created" as const,
        downstream: [],
        bindings: [],
        props: { hello: "world" },
        attr: { id: "kept" },
      };
      yield* teardownStateStore({ workerName });

      // First use deploys the store and attaches the domain to its Worker.
      const state = yield* State.pipe(
        Effect.flatten,
        Effect.provide(Cloudflare.state({ workerName, domain })),
      );
      yield* state.set({ stack: "domain", stage: "test", fqn: "domain/a", value: record });
      expect(yield* attachedDomains(accountId, domain)).toEqual([workerName]);

      // A fresh login reads the token through a preview served on the domain
      // and points the store at it.
      const profile = yield* currentProfileName;
      const credentials = yield* loginWithCloudflare(profile, true, workerName, accountId, domain);
      expect(credentials.url).toBe(`https://${domain}`);
      expect(yield* checkHttpStateStoreAuth(credentials)).toBe(true);
      const adopted = yield* bootstrap({ workerName, domain });
      expect(yield* adopted.get({ stack: "domain", stage: "test", fqn: "domain/a" })).toEqual(
        record,
      );

      yield* teardownStateStore({ workerName });
      expect(yield* scriptExists(accountId, workerName)).toBe(false);
      expect(yield* attachedDomains(accountId, domain)).toEqual([]);
    }),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:statestore", "live"],
    timeout: 300_000,
  },
);
