import { expect, it } from "@alchemy.run/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import path from "pathe";
import {
  AuthError,
  AuthProvider,
  AuthProviderLayer,
  AuthProviders,
  AuthProvidersLive,
  getAuthProvider,
  NeedsReauth,
} from "@/Auth/AuthProvider.ts";
import { inspectProvider } from "@/Auth/Inspect.ts";
import {
  configFilePath,
  credentialsDirPath,
  makeProviderProfileSchema,
  PROFILE_FORMAT,
  profileCredentialsDirPath,
  profileDirPath,
  profileProviderFilePath,
  ProfileError,
  ProfileStore,
  ProfileStoreLive,
  reloadProviderConfig,
  SuppressMissingProviderConfig,
  validateProfileName,
} from "@/Auth/Profile.ts";
import { resolveProfileName, resolveProviderConfig } from "@/Auth/Resolve.ts";
import * as Interaction from "@/Interaction.ts";
import { messageForCapabilities } from "@/Util/interactive.ts";

const FAKE_PROVIDER = "FakeAuthProvider";

it.effect(
  "selects guidance from injected interaction capabilities",
  () =>
    Effect.gen(function* () {
      expect(
        yield* messageForCapabilities(Effect.succeed({ input: true }), "interactive", "plain"),
      ).toBe("interactive");
      expect(
        yield* messageForCapabilities(Effect.succeed({ input: false }), "interactive", "plain"),
      ).toBe("plain");
    }),
  { tags: ["unit", "local"] },
);

// Records whether the lock-wrapped `configure` was ever entered. A missing
// profile must short-circuit before provider configuration starts.
const state = { configureCalls: 0 };

const FakeAuth = AuthProviderLayer<{ method: "stored" }, undefined>()(FAKE_PROVIDER, {
  configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
  configure: () =>
    Effect.sync(() => {
      state.configureCalls += 1;
      return { method: "stored" as const };
    }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: () => Effect.succeed(undefined),
});

const ENV_PROVIDER = "FakeEnvAuthProvider";

/** A provider that supports both profile and environment credentials. */
const fakeEnvImpl = {
  configSchema: Schema.Struct({ method: Schema.Literal("stored") }),
  configure: () => Effect.succeed({ method: "stored" as const }),
  login: () => Effect.void,
  logout: () => Effect.void,
  details: () => Effect.succeed({ lines: [] }),
  read: () => Effect.succeed("profile-credentials"),
  readEnvironment: Effect.succeed("environment-credentials"),
  environment: [{ name: "FAKE_ENV_TOKEN", required: true, secret: true }],
};

const FakeEnvAuth = AuthProviderLayer<{ method: "stored" }, string>()(ENV_PROVIDER, fakeEnvImpl);

const ROTATING_PROVIDER = "FakeRotatingAuthProvider";

/**
 * Refresh tokens are single-use, as with Cloudflare OAuth: refreshing
 * persists a new token, and presenting a spent one revokes the grant.
 */
type RotationState = { readonly refreshes: number; readonly spent: ReadonlySet<string> };

class Rotation extends Context.Service<Rotation, Ref.Ref<RotationState>>()("Test/Rotation") {}

const RotationLive = Layer.effect(
  Rotation,
  Ref.make<RotationState>({ refreshes: 0, spent: new Set() }),
);

type RotatingConfig = { method: "oauth"; refresh: string; expires: number };

const FakeRotatingAuth = AuthProviderLayer<RotatingConfig, string>()(
  ROTATING_PROVIDER,
  Effect.gen(function* () {
    const rotation = yield* Rotation;
    const rotate = Effect.fn(function* (
      profileName: string,
      config: RotatingConfig,
      updateConfig?: (config: RotatingConfig) => Effect.Effect<void, AuthError>,
    ) {
      const now = yield* Clock.currentTimeMillis;
      if (config.expires > now) return config.refresh;
      const next = yield* Ref.modify(rotation, (state) =>
        state.spent.has(config.refresh)
          ? [undefined, state]
          : [
              `r${state.refreshes + 1}`,
              { refreshes: state.refreshes + 1, spent: new Set([...state.spent, config.refresh]) },
            ],
      );
      if (next === undefined) {
        return yield* NeedsReauth.make({
          provider: ROTATING_PROVIDER,
          profile: profileName,
          message: `refresh token ${config.refresh} was already used`,
        });
      }
      yield* (
        updateConfig?.({ method: "oauth", refresh: next, expires: now + 3_600_000 }) ?? Effect.void
      );
      return next;
    });
    return {
      configSchema: Schema.Struct({
        method: Schema.Literal("oauth"),
        refresh: Schema.String,
        expires: Schema.Number,
      }),
      configure: () => Effect.succeed({ method: "oauth" as const, refresh: "r0", expires: 0 }),
      login: (
        _profileName: string,
        config: RotatingConfig,
        _updateConfig?: (config: RotatingConfig) => Effect.Effect<void, AuthError>,
        reload?: Effect.Effect<RotatingConfig, AuthError>,
      ) => Effect.map(reload ?? Effect.succeed(config), (current) => ({ ...current, expires: 1 })),
      logout: () => Effect.void,
      details: (
        profileName: string,
        config: RotatingConfig,
        updateConfig?: (config: RotatingConfig) => Effect.Effect<void, AuthError>,
      ) =>
        Effect.map(rotate(profileName, config, updateConfig), (token) => ({
          lines: [{ key: "token", value: token }],
        })),
      read: rotate,
    };
  }),
);

const makeTestLayer = (config: Record<string, unknown> = {}) =>
  Layer.mergeAll(ProfileStoreLive, FakeAuth, FakeEnvAuth, FakeRotatingAuth).pipe(
    Layer.provideMerge(RotationLive),
    Layer.provideMerge(
      Layer.mergeAll(
        AuthProvidersLive,
        ConfigProvider.layer(ConfigProvider.fromUnknown(config)),
        NodeServices.layer,
      ),
    ),
  );

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory for the duration of
 * `effect`, so store operations never touch the developer's real
 * `~/.alchemy`. Tests using this must be `exclusive` — the env var is
 * process-global.
 */
const withTempHome = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  config: Record<string, unknown> = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "alchemy-auth-" });
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

it.live(
  "loadProviderConfig requires profiles to be explicitly created",
  () =>
    withTempHome(
      Effect.gen(function* () {
        state.configureCalls = 0;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(FAKE_PROVIDER);

        const error = yield* profile.loadProviderConfig(auth, "non-existent").pipe(Effect.flip);

        expect(error).toBeInstanceOf(ProfileError);
        expect((error as ProfileError).message).toContain("profile create");
        // The lock-wrapped `configure` must never run.
        expect(state.configureCalls).toBe(0);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "loadProviderConfig never configures a missing provider implicitly",
  () =>
    withTempHome(
      Effect.gen(function* () {
        state.configureCalls = 0;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(FAKE_PROVIDER);
        yield* profile.createProfile("explicit-login");

        const error = yield* profile.loadProviderConfig(auth, "explicit-login").pipe(Effect.flip);

        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain(
          `alchemy profile edit --profile explicit-login --add ${FAKE_PROVIDER}`,
        );
        expect(state.configureCalls).toBe(0);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "the built-in default profile always exists",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        const fs = yield* FileSystem.FileSystem;
        // Never written to disk, yet the reader still presents `default`
        // with its deterministic id.
        const manifest = yield* profile.readManifest;
        expect(Object.keys(manifest.profiles)).toEqual(["default"]);
        expect(manifest.profiles.default!.id).toBe("default");
        expect(yield* fs.exists(profileDirPath("default"))).toBe(true);
        expect(yield* profile.ensureProfile("default")).toEqual({ id: "default", providers: {} });
        // With no explicit selection every command lands on `default`.
        const selection = yield* profile.current;
        expect(selection).toEqual({ name: "default", source: "default" });
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "the default profile cannot be deleted, renamed, or shadowed",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        // Creating a profile only creates its directory. The built-in
        // default remains synthesized until it has a provider file.
        yield* profile.createProfile("work");

        const renameError = yield* profile.renameProfile("default", "other").pipe(Effect.flip);
        expect(renameError).toBeInstanceOf(ProfileError);
        expect((renameError as ProfileError).message).toContain("Cannot rename");

        const deleteError = yield* profile.deleteProfile("default").pipe(Effect.flip);
        expect(deleteError).toBeInstanceOf(ProfileError);
        expect((deleteError as ProfileError).message).toContain("Cannot delete");

        const createError = yield* profile.createProfile("default").pipe(Effect.flip);
        expect((createError as ProfileError).message).toContain("already exists");

        const shadowError = yield* profile.renameProfile("work", "default").pipe(Effect.flip);
        expect((shadowError as ProfileError).message).toContain("already exists");

        expect(yield* fs.exists(profileDirPath("work"))).toBe(true);
        expect(yield* fs.exists(configFilePath())).toBe(false);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "migrates centralized manifests into provider files",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        yield* fs.makeDirectory(path.dirname(configFilePath()), { recursive: true });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            futureField: { anything: true },
            profiles: { legacy: { Cloudflare: { method: "oauth", scopes: ["d1.write"] } } },
          }),
        );

        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.legacy!.id).toBe("legacy");
        expect(manifest.profiles.legacy!.providers.Cloudflare).toEqual({ method: "oauth" });
        expect(manifest.profiles.default!.id).toBe("default");

        const providerFile = JSON.parse(
          yield* fs.readFileString(profileProviderFilePath("legacy", "Cloudflare")),
        );
        expect(providerFile).toEqual({
          format: PROFILE_FORMAT,
          provider: "Cloudflare",
          metadata: {},
          values: { method: "oauth" },
        });
        expect(yield* fs.exists(configFilePath())).toBe(false);
        expect(
          (yield* fs.readDirectory(path.dirname(configFilePath()))).filter((entry) =>
            entry.startsWith(".profiles-v0-"),
          ),
        ).toHaveLength(1);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "folds v0 credential sidecars into provider files",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const sidecars = profileCredentialsDirPath("legacy");
        yield* fs.makeDirectory(sidecars, { recursive: true });
        const sidecar = (name: string, contents: unknown) =>
          fs.writeFileString(
            path.join(sidecars, `${name}.json`),
            typeof contents === "string" ? contents : JSON.stringify(contents),
          );
        // The earliest GitHub sidecar name.
        yield* sidecar("gh-stored", { type: "stored", token: "ghp" });
        // Axiom's v0 `apiToken` is now `token`.
        yield* sidecar("axiom-stored", { type: "stored", apiToken: "xaat", orgId: "org" });
        yield* sidecar("cloudflare-stored", {
          credentialType: "apiToken",
          apiToken: "cf",
          accountId: "acct",
        });
        // Providers with several methods pick the sidecar by `method`.
        yield* sidecar("railway-oauth", { accessToken: "rw" });
        yield* sidecar("hetzner-stored", "{not-json");
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: {
              legacy: {
                GitHub: { method: "stored", storageKey: "gh" },
                Axiom: { method: "stored" },
                Cloudflare: { method: "stored" },
                Railway: { method: "oauth" },
                Neon: { method: "stored" },
                Hetzner: { method: "stored" },
              },
            },
          }),
        );

        const providers = (yield* profile.readManifest).profiles.legacy!.providers;
        expect(providers.GitHub).toEqual({ method: "stored", token: "ghp" });
        expect(providers.Axiom).toEqual({ method: "stored", token: "xaat", orgId: "org" });
        expect(providers.Cloudflare).toEqual({
          method: "stored",
          credentialType: "apiToken",
          apiToken: "cf",
          accountId: "acct",
        });
        expect(providers.Railway).toEqual({ method: "oauth", accessToken: "rw" });
        // A missing or unreadable sidecar keeps the manifest values; the
        // original stays in the v0 backup.
        expect(providers.Neon).toEqual({ method: "stored" });
        expect(providers.Hetzner).toEqual({ method: "stored" });
        expect(yield* fs.exists(credentialsDirPath())).toBe(false);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "drops a v0 Cloudflare entry whose sidecar is incomplete",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const sidecars = profileCredentialsDirPath("legacy");
        yield* fs.makeDirectory(sidecars, { recursive: true });
        // The earliest Cloudflare sidecar name, missing its account.
        yield* fs.writeFileString(
          path.join(sidecars, "cf-stored.json"),
          JSON.stringify({ credentialType: "apiToken", apiToken: "cf" }),
        );
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: { legacy: { Cloudflare: { method: "stored" } } },
          }),
        );

        const providers = (yield* profile.readManifest).profiles.legacy!.providers;
        expect(providers.Cloudflare).toEqual({});
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "ignores unreleased centralized manifest versions",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        yield* fs.makeDirectory(path.dirname(configFilePath()), { recursive: true });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({ version: 1, defaultProfile: "work", profiles: { work: {} } }),
        );

        // Only released v0 is migrated. The short-lived centralized v1/v2
        // formats are left untouched and do not enter the directory store.
        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.work).toBeUndefined();
        expect((yield* profile.current).name).toBe("default");

        yield* profile.createProfile("scratch");
        expect(yield* fs.exists(profileDirPath("work"))).toBe(false);
        expect(yield* fs.exists(profileDirPath("scratch"))).toBe(true);
        expect(yield* fs.exists(configFilePath())).toBe(true);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "backs up invalid provider files and continues loading the profile",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profiles = yield* ProfileStore;
        yield* fs.writeFileString(profileProviderFilePath("default", "Cloudflare"), "{not-json");
        yield* fs.writeFileString(
          profileProviderFilePath("default", "Other"),
          JSON.stringify({
            format: PROFILE_FORMAT,
            provider: "Other",
            metadata: {},
            values: { method: "stored" },
          }),
        );

        const manifest = yield* profiles.readManifest;
        expect(manifest.profiles.default!.providers.Cloudflare).toBeUndefined();
        expect(manifest.profiles.default!.providers.Other).toEqual({ method: "stored" });
        const files = yield* fs.readDirectory(profileDirPath("default"));
        expect(files).toContain("other.json");
        expect(files.some((file) => file.startsWith("cloudflare.json.invalid-"))).toBe(true);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "backs up an invalid provider file before reconfiguration replaces it",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profiles = yield* ProfileStore;
        const file = profileProviderFilePath("default", "Cloudflare");
        yield* fs.writeFileString(file, "{not-json");

        yield* profiles.setProviderConfig("default", "Cloudflare", { method: "oauth" });

        expect(JSON.parse(yield* fs.readFileString(file))).toEqual({
          format: PROFILE_FORMAT,
          provider: "Cloudflare",
          metadata: {},
          values: { method: "oauth" },
        });
        expect(
          (yield* fs.readDirectory(profileDirPath("default"))).some((entry) =>
            entry.startsWith("cloudflare.json.invalid-"),
          ),
        ).toBe(true);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "legacy env-method entries are dropped on read",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(FAKE_PROVIDER);
        yield* fs.makeDirectory(path.dirname(configFilePath()), { recursive: true });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: { ci: { [FAKE_PROVIDER]: { method: "env" }, Other: { method: "stored" } } },
          }),
        );

        // The env-backed entry never surfaces: not in the read manifest...
        const manifest = yield* profile.readManifest;
        expect(manifest.profiles.ci!.providers[FAKE_PROVIDER]).toBeUndefined();
        expect(manifest.profiles.ci!.providers.Other).toEqual({ method: "stored" });

        // ...and credential resolution reports "not configured" with the
        // hint to connect the provider, not a legacy-env special case.
        const error = yield* profile.loadProviderConfig(auth, "ci").pipe(Effect.flip);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain("--add");

        expect(yield* fs.exists(profileProviderFilePath("ci", FAKE_PROVIDER))).toBe(false);
        expect(yield* fs.exists(profileProviderFilePath("ci", "Other"))).toBe(true);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.effect(
  "accepts portable profile names",
  () =>
    Effect.gen(function* () {
      expect(yield* validateProfileName("production-admin")).toBe("production-admin");
      expect(yield* validateProfileName("team.prod_2")).toBe("team.prod_2");
    }),
  { tags: ["unit", "local"] },
);

it.effect(
  "lets custom providers refine metadata and values",
  () =>
    Effect.gen(function* () {
      const CustomProfile = makeProviderProfileSchema(
        "Acme",
        Schema.Struct({ team: Schema.String }),
        Schema.Union([
          Schema.Struct({ method: Schema.Literal("token"), token: Schema.String }),
          Schema.Struct({
            method: Schema.Literal("oauth"),
            access: Schema.String,
            refresh: Schema.String,
            scopes: Schema.Array(Schema.String),
          }),
        ]),
      );
      expect(
        yield* Schema.decodeUnknownEffect(CustomProfile)({
          format: PROFILE_FORMAT,
          provider: "Acme",
          metadata: { team: "platform" },
          values: { method: "token", token: "secret" },
        }),
      ).toEqual({
        format: PROFILE_FORMAT,
        provider: "Acme",
        metadata: { team: "platform" },
        values: { method: "token", token: "secret" },
      });
    }),
  { tags: ["unit", "local"] },
);

it.effect(
  "rejects profile names that can escape the credential directory",
  () =>
    Effect.gen(function* () {
      for (const name of ["..", "../..", "team/prod", "/tmp/profile", ""]) {
        const error = yield* validateProfileName(name).pipe(Effect.flip);
        expect(error).toBeInstanceOf(ProfileError);
      }
    }),
  { tags: ["unit", "local"] },
);

it.effect(
  "preserves CLI and explicit env-file precedence over the process profile",
  () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const previous = process.env.ALCHEMY_PROFILE;
          delete process.env.ALCHEMY_PROFILE;
          return previous;
        }),
        (previous) =>
          Effect.sync(() => {
            if (previous === undefined) delete process.env.ALCHEMY_PROFILE;
            else process.env.ALCHEMY_PROFILE = previous;
          }),
      );
      const fs = yield* FileSystem.FileSystem;
      const file = yield* fs.makeTempFileScoped();
      yield* fs.writeFileString(file, "ALCHEMY_PROFILE=from-env-file\n");

      expect(yield* resolveProfileName(Option.some(file), undefined)).toBe("from-env-file");
      expect(yield* resolveProfileName(Option.some(file), "from-cli")).toBe("from-cli");

      yield* Effect.sync(() => {
        process.env.ALCHEMY_PROFILE = "from-process";
      });
      expect(yield* resolveProfileName(Option.some(file), undefined)).toBe("from-env-file");
      expect(yield* resolveProfileName(Option.some(file), "from-cli")).toBe("from-cli");
    }).pipe(Effect.scoped, Effect.provide(makeTestLayer())),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "environment notices share a provider cache and reset when its layer is rebuilt",
  () => {
    const messages: unknown[] = [];
    const run = withTempHome(
      Effect.gen(function* () {
        yield* AuthProvider<{ method: "stored" }, string>()("OtherNoticeProvider", fakeEnvImpl);
        const resolve = resolveProviderConfig(ENV_PROVIDER);
        yield* resolve.pipe(Effect.provideService(SuppressMissingProviderConfig, true));
        expect(messages).toEqual([]);
        const results = yield* Effect.all(
          Array.from({ length: 10 }, () => resolve),
          { concurrency: "unbounded" },
        );
        for (const result of results) {
          expect(yield* result.resolve).toBe("environment-credentials");
        }
        yield* resolveProviderConfig("OtherNoticeProvider");
        expect(messages).toEqual([
          ["FakeEnvAuthProvider: using environment variables (FAKE_ENV_TOKEN)."],
          ["OtherNoticeProvider: using environment variables (FAKE_ENV_TOKEN)."],
        ]);
      }),
      { FAKE_ENV_TOKEN: "from-env" },
    );
    return Effect.gen(function* () {
      yield* run;
      messages.length = 0;
      yield* run;
    }).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make<unknown, void>((options) => {
            messages.push(options.message);
          }),
        ]),
      ),
    );
  },
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "concurrent resolves of an expired credential refresh it once",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        yield* profile.setProviderConfig("default", ROTATING_PROVIDER, {
          method: "oauth",
          refresh: "r0",
          expires: 0,
        });
        // Each resolution loads the profile up front, as two processes
        // (say `plan` and a state read) starting together would.
        const first = yield* resolveProviderConfig<RotatingConfig, string>(ROTATING_PROVIDER);
        const second = yield* resolveProviderConfig<RotatingConfig, string>(ROTATING_PROVIDER);

        const tokens = yield* Effect.all([first.resolve, second.resolve], {
          concurrency: "unbounded",
        });

        expect(tokens).toEqual(["r1", "r1"]);
        expect((yield* Ref.get(yield* Rotation)).refreshes).toBe(1);
        // A later resolve in the same process reads the rotated token too.
        expect(yield* first.resolve).toBe("r1");
        expect((yield* Ref.get(yield* Rotation)).refreshes).toBe(1);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "concurrent inspections of an expired credential refresh it once",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        const registered = yield* AuthProviders;
        const stale = { method: "oauth", refresh: "r0", expires: 0 };
        yield* profile.setProviderConfig("default", ROTATING_PROVIDER, stale);
        const persist = (updated: Record<string, unknown>) =>
          profile
            .setProviderConfig("default", ROTATING_PROVIDER, updated)
            .pipe(Effect.mapError((cause) => AuthError.make({ message: cause.message, cause })));
        // Both inspections start from the config read before either refresh,
        // as two `alchemy profile show` processes started together would.
        const inspect = inspectProvider("default", ROTATING_PROVIDER, stale, registered, persist);
        const connections = yield* Effect.all([inspect, inspect], {
          concurrency: "unbounded",
        }).pipe(Effect.provide(Interaction.layerNonInteractive()));

        expect(connections.map((c) => c.status)).toEqual(["connected", "connected"]);
        expect((yield* Ref.get(yield* Rotation)).refreshes).toBe(1);
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "login hands the provider a reload of the stored config",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        yield* profile.setProviderConfig("default", ROTATING_PROVIDER, {
          method: "oauth",
          refresh: "r7",
          expires: 0,
        });
        const auth = yield* getAuthProvider<RotatingConfig, string>(ROTATING_PROVIDER);

        const refreshed = yield* auth
          .login(
            "default",
            { method: "oauth", refresh: "r0", expires: 0 },
            undefined,
            reloadProviderConfig(profile, auth, "default"),
          )
          .pipe(Effect.provide(Interaction.layerNonInteractive()));

        expect(refreshed).toMatchObject({ refresh: "r7" });
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "provider variables present in config resolve without a profile",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const resolved = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(resolved.source).toBe("environment");
        expect(yield* resolved.resolve).toBe("environment-credentials");
      }),
      // Environment credentials are read through the config provider —
      // the process environment, `.env`, and `--env-file` alike.
      { FAKE_ENV_TOKEN: "from-env" },
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "provider environment variables take precedence over a selected profile",
  () =>
    withTempHome(
      Effect.gen(function* () {
        // ALCHEMY_PROFILE (the --profile mechanism) selects a profile, but
        // a fully present environment contract still wins — the profile
        // is never consulted, so its unconfigured provider cannot fail.
        const resolved = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(resolved.source).toBe("environment");
        expect(resolved.profileName).toBeUndefined();
        expect(yield* resolved.resolve).toBe("environment-credentials");
      }),
      { ALCHEMY_PROFILE: "default", FAKE_ENV_TOKEN: "from-env" },
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "providers mix: one from environment variables, the rest from the profile",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const profile = yield* ProfileStore;
        yield* profile.setProviderConfig("default", FAKE_PROVIDER, { method: "stored" });
        // Precedence is decided per provider, not per run: the provider
        // whose contract is present resolves from the environment while a
        // provider without those variables still comes from the profile.
        const fromEnv = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(fromEnv.source).toBe("environment");
        const fromProfile = yield* resolveProviderConfig(FAKE_PROVIDER);
        expect(fromProfile.source).toBe("profile");
        expect(fromProfile.profileName).toBe("default");
      }),
      { FAKE_ENV_TOKEN: "from-env" },
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "CI resolves environment credentials without touching profiles",
  () =>
    withTempHome(
      Effect.gen(function* () {
        // No process.env presence required: CI reads through the config
        // provider (env + --env-file) and never consults the profile.
        const resolved = yield* resolveProviderConfig(ENV_PROVIDER);
        expect(resolved.source).toBe("environment");
        expect(resolved.profileName).toBeUndefined();
      }),
      { CI: true, ALCHEMY_PROFILE: "default" },
    ),
  { tags: ["unit", "local"], exclusive: true },
);

it.live(
  "an invalid stored provider entry fails with a reconfigure hint",
  () =>
    withTempHome(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profile = yield* ProfileStore;
        const auth = yield* getAuthProvider<{ method: "stored" }, undefined>(FAKE_PROVIDER);
        yield* fs.makeDirectory(path.dirname(configFilePath()), { recursive: true });
        yield* fs.writeFileString(
          configFilePath(),
          JSON.stringify({
            version: 0,
            profiles: { ci: { [FAKE_PROVIDER]: { method: "bogus" } } },
          }),
        );

        const error = yield* profile.loadProviderConfig(auth, "ci").pipe(Effect.flip);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).message).toContain("--reconfigure");
      }),
    ),
  { tags: ["unit", "local"], exclusive: true },
);
