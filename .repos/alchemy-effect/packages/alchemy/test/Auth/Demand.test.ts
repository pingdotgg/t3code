import {
  AuthProviderLayer,
  AuthProviders,
  NeedsReauth,
} from "@/Auth/AuthProvider.ts";
import {
  type CredentialDemand,
  type CredentialsRequired,
  demandCredentials,
} from "@/Auth/Demand.ts";
import { ProfileStore, ProfileStoreLive } from "@/Auth/Profile.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const PROBE = "DemandProbe";

/**
 * Every credential touch goes through `read` — the counter is how the tests
 * prove both directions: warm-up runs it exactly once per demanded provider,
 * and a zero-demand run never runs it at all.
 */
const state = { reads: 0, mode: "ok" as "ok" | "needs-reauth" };

const ProbeAuth = AuthProviderLayer<{ method: "stored" }, string>()(PROBE, {
  configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
  configure: () => Effect.succeed({ method: "stored" as const }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: (profileName) =>
    Effect.suspend(() => {
      state.reads += 1;
      return state.mode === "ok"
        ? Effect.succeed("probe-credentials")
        : Effect.fail(
            new NeedsReauth({
              provider: PROBE,
              profile: profileName,
              message: "Probe refresh token is dead.",
            }),
          );
    }),
});

const ENV_PROBE = "DemandEnvProbe";
const ENV_PROBE_TOKEN = "DEMAND_PROBE_TOKEN";
const envState = { reads: 0 };

/** A provider that also supports environment credentials. */
const EnvProbeAuth = AuthProviderLayer<{ method: "stored" }, string>()(
  ENV_PROBE,
  {
    configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
    configure: () => Effect.succeed({ method: "stored" as const }),
    login: () => Effect.void,
    logout: () => Effect.void,
    details: () => Effect.succeed({ lines: [] }),
    read: () => Effect.succeed("profile-credentials"),
    readEnvironment: Effect.sync(() => {
      envState.reads += 1;
      return "env-credentials";
    }),
    environment: [{ name: ENV_PROBE_TOKEN, required: true, secret: true }],
  },
);

const makeTestLayer = (config: Record<string, unknown> = {}) =>
  Layer.mergeAll(ProfileStoreLive, ProbeAuth, EnvProbeAuth).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        // Fully replaces the ambient provider: an exported CI=1 (or
        // ALCHEMY_PROFILE) in the developer's shell must not leak into the
        // demand seam under test.
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
        NodeServices.layer,
      ),
    ),
  );

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory so the store never
 * touches the developer's real `~/.alchemy`. Tests using this must be
 * `exclusive` — the env var is process-global.
 */
const withTempHome = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    state.reads = 0;
    state.mode = "ok";
    envState.reads = 0;
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-demand-",
    });
    const previous = process.env.ALCHEMY_HOME;
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        process.env.ALCHEMY_HOME = dir;
      }),
      () =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.ALCHEMY_HOME;
          else process.env.ALCHEMY_HOME = previous;
        }),
    );
    return yield* effect.pipe(Effect.provide(makeTestLayer(config)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

const configureProbe = Effect.gen(function* () {
  const profile = yield* ProfileStore;
  yield* profile.setProviderConfig("default", PROBE, { method: "stored" });
});

const demand: CredentialDemand = {
  provider: PROBE,
  resources: [{ fqn: "Website", reason: "remote" }],
};

it.live(
  "zero demand touches no credentials at all",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* configureProbe;
        yield* demandCredentials([]);
        expect(state.reads).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "a demanded provider is warmed up through its real read path",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* configureProbe;
        yield* demandCredentials([demand]);
        expect(state.reads).toBe(1);
      }),
    ),
  { exclusive: true },
);

it.live(
  "a dead token fails typed before apply, naming the demanding resources",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* configureProbe;
        state.mode = "needs-reauth";
        const error = yield* Effect.flip(demandCredentials([demand]));
        expect(error._tag).toBe("NeedsReauth");
        expect(error.message).toContain("Probe refresh token is dead.");
        expect(error.message).toContain(
          `These resources require ${PROBE} credentials:`,
        );
        expect(error.message).toContain("Website");
        expect(error.message).toContain("Alchemy.remote()");
      }),
    ),
  { exclusive: true },
);

it.live(
  "an unconfigured provider fails with CredentialsRequired and never reads",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const error = (yield* Effect.flip(
          demandCredentials([demand]),
        )) as CredentialsRequired;
        expect(error._tag).toBe("CredentialsRequired");
        expect(error.resources).toEqual(["Website"]);
        expect(error.message).toContain(`--add ${PROBE}`);
        expect(state.reads).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "a nonexistent explicit profile fails with the actionable CredentialsRequired",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const error = (yield* Effect.flip(
          demandCredentials([demand]),
        )) as CredentialsRequired;
        // NOT a generic ProfileError: the user must still learn which
        // resources demanded credentials and which command fixes it.
        expect(error._tag).toBe("CredentialsRequired");
        expect(error.message).toContain("ghost");
        expect(error.message).toContain("Website");
        expect(state.reads).toBe(0);
      }),
      { ALCHEMY_PROFILE: "ghost" },
    ),
  { exclusive: true },
);

it.live(
  "exported env credentials satisfy the gate when no profile is selected",
  () =>
    withTempHome(
      Effect.gen(function* () {
        yield* demandCredentials([
          {
            provider: ENV_PROBE,
            resources: [{ fqn: "Api", reason: "remote" }],
          },
        ]);
        // The gate warmed through the provider's environment path — the
        // same source the run's lazy resolution will use.
        expect(envState.reads).toBe(1);
      }),
      { [ENV_PROBE_TOKEN]: "token" },
    ),
  { exclusive: true },
);
