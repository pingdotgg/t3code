import { AuthProviders } from "@/Auth/AuthProvider.ts";
import {
  PROFILE_FORMAT,
  profileProviderFilePath,
  ProfileStore,
  ProfileStoreLive,
} from "@/Auth/Profile.ts";
import { GitHubAuthConfigSchema } from "@/GitHub/AuthProvider.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import path from "pathe";

const FIXTURE_HOME = path.join(import.meta.dirname, "fixtures/v0-home");

const testLayer = () =>
  ProfileStoreLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(AuthProviders, {}),
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
        NodeServices.layer,
      ),
    ),
  );

/**
 * Point `ALCHEMY_HOME` at a scoped temp directory seeded from a fixture
 * tree, so store operations never touch the developer's real `~/.alchemy`.
 * Tests using this must be `exclusive` — the env var is process-global.
 */
const withFixtureHome = <A, E, R>(
  fixture: string | undefined,
  effect: (home: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({
      prefix: "alchemy-migrate-",
    });
    if (fixture !== undefined) {
      yield* fs.copyFile(
        path.join(fixture, "profiles.json"),
        path.join(dir, "profiles.json"),
      );
      yield* fs.copy(
        path.join(fixture, "credentials"),
        path.join(dir, "credentials"),
      );
    }
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
    return yield* effect(dir).pipe(Effect.provide(testLayer()));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live(
  "migrates a full v0 store: entries kept, credentials dropped into a backup",
  () =>
    withFixtureHome(FIXTURE_HOME, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const store = yield* ProfileStore;

        // The first read performs the on-disk migration.
        const manifest = yield* store.readManifest;

        // Every profile and provider entry survives (ids backfilled from the
        // profile name), except legacy `method: "env"` entries.
        expect(Object.keys(manifest.profiles).sort()).toEqual([
          "default",
          "work",
        ]);
        expect(manifest.profiles.default?.id).toBe("default");
        expect(manifest.profiles.work?.id).toBe("work");
        expect(manifest.profiles.default?.providers.Cloudflare).toEqual({
          method: "oauth",
        });
        expect(manifest.profiles.default?.providers.AWS?.method).toBe("sso");
        expect(manifest.profiles.default?.providers.GitHub).toEqual({
          method: "gh-cli",
        });
        expect(
          Schema.decodeUnknownSync(GitHubAuthConfigSchema)(
            manifest.profiles.default?.providers.GitHub,
          ),
        ).toEqual({ method: "gh-cli" });
        expect(manifest.profiles.default?.providers.Neon).toBeUndefined();
        expect(manifest.profiles.work?.providers.GitHub?.method).toBe("stored");
        expect(manifest.profiles.work?.providers.Axiom?.method).toBe("stored");
        expect(manifest.profiles.work?.providers.Cloudflare).toEqual({
          method: "stored",
          credentialType: "apiKey",
          apiKey: "v0-cf-global-api-key",
          email: "worker@example.com",
          accountId: "0123456789abcdef0123456789abcdef",
        });
        expect(manifest.profiles.work?.providers.GitHub?.token).toBe(
          "ghp_v0token",
        );
        expect(manifest.profiles.work?.providers.Axiom).toEqual({
          method: "stored",
          token: "xaat-v0-token",
          apiBaseUrl: "https://api.axiom.co",
        });

        // Each provider is now its own document. Compatible provider values
        // survive. Cloudflare OAuth is deliberately emptied because its old
        // grant is obsolete; stored API key credentials remain compatible.
        const aws = JSON.parse(
          yield* fs.readFileString(profileProviderFilePath("default", "AWS")),
        );
        expect(aws).toEqual({
          format: PROFILE_FORMAT,
          provider: "AWS",
          metadata: {},
          values: { method: "sso", ssoProfile: "dev" },
        });
        const oauthCloudflare = JSON.parse(
          yield* fs.readFileString(
            profileProviderFilePath("default", "Cloudflare"),
          ),
        );
        expect(oauthCloudflare.values).toEqual({ method: "oauth" });
        const storedCloudflare = JSON.parse(
          yield* fs.readFileString(
            profileProviderFilePath("work", "Cloudflare"),
          ),
        );
        expect(storedCloudflare.values).toEqual(
          manifest.profiles.work?.providers.Cloudflare,
        );
        expect(
          (yield* fs.readDirectory(path.join(home, "profiles/default"))).sort(),
        ).toEqual(["aws.json", "cloudflare.json", "github.json"]);
        expect(
          yield* fs.exists(profileProviderFilePath("default", "Neon")),
        ).toBe(false);
        expect(yield* fs.exists(path.join(home, "profiles.json"))).toBe(false);

        // The original manifest and every credential file are preserved in
        // a timestamped backup for manual recovery.
        const backups = (yield* fs.readDirectory(home)).filter((entry) =>
          entry.startsWith(".profiles-v0-"),
        );
        expect(backups).toHaveLength(1);
        const backupDir = path.join(home, backups[0]!);
        const backedUp = JSON.parse(
          yield* fs.readFileString(path.join(backupDir, "profiles.json")),
        );
        expect(backedUp.version).toBe(0);
        // v0 profiles are flat provider maps (no `providers` wrapper).
        expect(backedUp.profiles.default.Neon.method).toBe("env");
        const oauth = JSON.parse(
          yield* fs.readFileString(
            path.join(backupDir, "credentials/default/cf-oauth.json"),
          ),
        );
        expect(oauth.refresh).toBe("v0-refresh-token");
        for (const file of [
          "credentials/default/cloudflare-state-store.json",
          "credentials/work/gh-stored.json",
          "credentials/work/axiom-stored.json",
          "credentials/work/cf-stored.json",
        ]) {
          expect(yield* fs.exists(path.join(backupDir, file))).toBe(true);
        }

        // The live credential store is gone; all obsolete sidecars live only
        // in the recoverable v0 backup.
        expect(yield* fs.exists(path.join(home, "credentials"))).toBe(false);

        // Idempotent: a second read is a plain current-version read — no new
        // backup dir, and the existing one is untouched.
        const again = yield* store.readManifest;
        expect(again.profiles.work?.providers.GitHub?.method).toBe("stored");
        expect(again.profiles.work?.providers.Cloudflare).toEqual(
          manifest.profiles.work?.providers.Cloudflare,
        );
        expect(
          (yield* fs.readDirectory(home)).filter((entry) =>
            entry.startsWith(".profiles-v0-"),
          ),
        ).toHaveLength(1);
        expect(
          JSON.parse(
            yield* fs.readFileString(path.join(backupDir, "profiles.json")),
          ).version,
        ).toBe(0);
      }),
    ),
  { exclusive: true },
);

it.live(
  "leaves the directory-backed store untouched",
  () =>
    withFixtureHome(undefined, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const providerFile = profileProviderFilePath("work", "Neon");
        yield* fs.makeDirectory(path.dirname(providerFile), {
          recursive: true,
        });
        yield* fs.writeFileString(
          providerFile,
          JSON.stringify({
            format: PROFILE_FORMAT,
            provider: "Neon",
            metadata: { label: "production" },
            values: { method: "stored", apiKey: "current-key" },
          }),
        );

        const store = yield* ProfileStore;
        const manifest = yield* store.readManifest;

        expect(manifest.profiles.work?.id).toBe("work");
        expect(manifest.profiles.work?.providers.Neon).toEqual({
          method: "stored",
          apiKey: "current-key",
        });
        expect(
          (yield* fs.readDirectory(home)).filter((entry) =>
            entry.startsWith(".profiles-v0-"),
          ),
        ).toHaveLength(0);
        expect(
          JSON.parse(yield* fs.readFileString(providerFile)).metadata,
        ).toEqual({ label: "production" });
      }),
    ),
  { exclusive: true },
);

it.live(
  "salvages valid v0 providers when another entry or sidecar is invalid",
  () =>
    withFixtureHome(FIXTURE_HOME, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const legacyFile = path.join(home, "profiles.json");
        const legacy = JSON.parse(yield* fs.readFileString(legacyFile));
        legacy.profiles.work.Broken = "not-an-object";
        yield* fs.writeFileString(legacyFile, JSON.stringify(legacy));
        yield* fs.writeFileString(
          path.join(home, "credentials/work/axiom-stored.json"),
          "{not-json",
        );

        const manifest = yield* (yield* ProfileStore).readManifest;
        expect(manifest.profiles.default?.providers.AWS).toEqual({
          method: "sso",
          ssoProfile: "dev",
        });
        expect(manifest.profiles.work?.providers.GitHub?.token).toBe(
          "ghp_v0token",
        );
        expect(manifest.profiles.work?.providers.Axiom).toEqual({
          method: "stored",
        });
        expect(manifest.profiles.work?.providers.Broken).toBeUndefined();

        const backup = (yield* fs.readDirectory(home)).find((entry) =>
          entry.startsWith(".profiles-v0-"),
        );
        expect(backup).toBeDefined();
        expect(
          yield* fs.readFileString(
            path.join(home, backup!, "credentials/work/axiom-stored.json"),
          ),
        ).toBe("{not-json");
      }),
    ),
  { exclusive: true },
);

it.live(
  "inlines every recognized v0 credential sidecar",
  () =>
    withFixtureHome(undefined, (home) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const staticCredentials = {
          "aws-stored": {
            accessKeyId: "AKIAFIXTURE",
            secretAccessKey: "aws-secret",
            region: "us-east-1",
          },
          "axiom-stored": {
            type: "apiToken",
            apiToken: "axiom-token",
            orgId: "axiom-org",
          },
          "fly-stored": { apiKey: "fly-token" },
          "github-stored": { type: "pat", token: "github-token" },
          "hetzner-stored": { token: "hetzner-token" },
          "neon-stored": { apiKey: "neon-key" },
          "planetscale-stored": {
            type: "apiToken",
            tokenId: "ps-token-id",
            token: "ps-token",
            organization: "ps-org",
          },
          "prisma-stored": { serviceToken: "prisma-token" },
          "railway-stored": { type: "token", token: "railway-token" },
        };
        const oauthCredentials = {
          "planetscale-oauth": {
            type: "oauth",
            clientId: "ps-client",
            access: "ps-access",
            refresh: "ps-refresh",
            expires: 4_102_444_800_000,
            scopes: ["read_organizations"],
          },
          "railway-oauth": { type: "token", token: "railway-oauth-token" },
        };
        yield* fs.writeFileString(
          path.join(home, "profiles.json"),
          JSON.stringify({
            version: 0,
            profiles: {
              static: {
                AWS: { method: "stored" },
                Axiom: { method: "stored" },
                Fly: { method: "stored" },
                GitHub: { method: "stored" },
                Hetzner: { method: "stored" },
                Neon: { method: "stored" },
                Planetscale: { method: "stored" },
                Prisma: { method: "stored" },
                Railway: { method: "stored" },
              },
              oauth: {
                Planetscale: { method: "oauth", organization: "ps-org" },
                Railway: { method: "oauth" },
              },
            },
          }),
        );
        for (const [profile, credentials] of Object.entries({
          static: staticCredentials,
          oauth: oauthCredentials,
        })) {
          const dir = path.join(home, "credentials", profile);
          yield* fs.makeDirectory(dir, { recursive: true });
          for (const [key, values] of Object.entries(credentials)) {
            yield* fs.writeFileString(
              path.join(dir, `${key}.json`),
              JSON.stringify(values),
            );
          }
        }

        const manifest = yield* (yield* ProfileStore).readManifest;
        expect(manifest.profiles.static?.providers).toEqual({
          AWS: {
            method: "stored",
            accessKeyId: "AKIAFIXTURE",
            secretAccessKey: "aws-secret",
            region: "us-east-1",
          },
          Axiom: {
            method: "stored",
            token: "axiom-token",
            orgId: "axiom-org",
          },
          Fly: { method: "stored", apiKey: "fly-token" },
          GitHub: { method: "stored", token: "github-token" },
          Hetzner: { method: "stored", token: "hetzner-token" },
          Neon: { method: "stored", apiKey: "neon-key" },
          Planetscale: {
            method: "stored",
            tokenId: "ps-token-id",
            token: "ps-token",
            organization: "ps-org",
          },
          Prisma: { method: "stored", serviceToken: "prisma-token" },
          Railway: { method: "stored", token: "railway-token" },
        });
        expect(manifest.profiles.oauth?.providers).toEqual({
          Planetscale: {
            method: "oauth",
            organization: "ps-org",
            clientId: "ps-client",
            access: "ps-access",
            refresh: "ps-refresh",
            expires: 4_102_444_800_000,
            scopes: ["read_organizations"],
          },
          Railway: { method: "oauth", token: "railway-oauth-token" },
        });
      }),
    ),
  { exclusive: true },
);
