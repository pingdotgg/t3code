import * as Cloudflare from "@/Cloudflare";
import * as Output from "@/Output.ts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const Database = Cloudflare.D1.Database("Database");
const apiEnv = Effect.gen(function* () {
  return { DB: yield* Database };
});

export class Api extends Cloudflare.Worker<Api>()(
  "Api",
  Effect.gen(function* () {
    return { main: "./api.ts", env: yield* apiEnv };
  }),
) {}

declare const env: Cloudflare.InferEnv<Api>;
declare const constructorEnv: Cloudflare.InferEnv<typeof Api>;
declare const resourceEnv: Cloudflare.InferEnv<Effect.Success<typeof Api>>;
declare const rawEnv: Cloudflare.InferEnv<Effect.Success<typeof apiEnv>>;

export const _database: D1Database = env.DB;
export const _constructorDatabase: D1Database = constructorEnv.DB;
export const _resourceDatabase: D1Database = resourceEnv.DB;
export const _rawDatabase: D1Database = rawEnv.DB;
export const _statement: D1PreparedStatement = env.DB.prepare("SELECT 1");
export const _keys: keyof Cloudflare.InferEnv<Api> = "DB";

// @ts-expect-error Undeclared bindings must not acquire an index signature.
env.MISSING;
// @ts-expect-error Constructor inference must preserve the binding keys.
constructorEnv.MISSING;
// @ts-expect-error Resource inference must preserve the binding keys.
resourceEnv.MISSING;
// @ts-expect-error The runtime binding is a D1 database, not a string.
export const _wrongDatabase: string = env.DB;
// @ts-expect-error Class brands are not environment bindings.
export const _brand: keyof Cloudflare.InferEnv<Api> = "~alchemy/Id";

export class Site extends Cloudflare.Worker<Site>()("Site", {
  script: "export default {}",
  assets: { directory: "./public" },
  env: {
    DB: Database,
    URL: Output.literal("https://example.com"),
    SECRET: Config.Redacted("SECRET"),
  },
}) {}

declare const siteEnv: Cloudflare.InferEnv<Site>;
declare const siteConstructorEnv: Cloudflare.InferEnv<typeof Site>;
export const _siteDatabase: D1Database = siteEnv.DB;
export const _siteUrl: string = siteEnv.URL;
export const _siteSecret: string = siteEnv.SECRET;
export const _siteAssets: Service = siteEnv.ASSETS;
export const _siteConstructorAssets: Service = siteConstructorEnv.ASSETS;
// @ts-expect-error Output bindings must not widen to any.
export const _wrongUrl: number = siteEnv.URL;
// @ts-expect-error Secrets are decrypted strings at runtime.
export const _wrongSecret: number = siteEnv.SECRET;
// @ts-expect-error Assets retain their native binding type.
export const _wrongAssets: string = siteEnv.ASSETS;

export class Empty extends Cloudflare.Worker<Empty>()("Empty", {
  script: "export default {}",
}) {}

declare const emptyKeys: keyof Cloudflare.InferEnv<Empty>;
declare const emptyConstructorKeys: keyof Cloudflare.InferEnv<typeof Empty>;
export const _emptyKeys: never = emptyKeys;
export const _emptyConstructorKeys: never = emptyConstructorKeys;

export class AssetsOnly extends Cloudflare.Worker<AssetsOnly>()("AssetsOnly", {
  assets: "./public",
}) {}

declare const assetsEnv: Cloudflare.InferEnv<AssetsOnly>;
export const _assetsOnly: Service = assetsEnv.ASSETS;
// @ts-expect-error Assets-only Workers have no other bindings.
assetsEnv.DB;

export const Functional = Cloudflare.Worker("Functional", {
  script: "export default {}",
  env: { DB: Database },
});
declare const functionalEnv: Cloudflare.InferEnv<typeof Functional>;
export const _functionalDatabase: D1Database = functionalEnv.DB;
// @ts-expect-error Functional Workers still reject undeclared bindings.
functionalEnv.MISSING;

// `R2.S3Credentials` on an async Worker's env arrives as a JSON string.
declare const s3Bucket: Cloudflare.R2.Bucket;
declare const s3Env: Cloudflare.InferEnv<{
  S3: ReturnType<typeof Cloudflare.R2.S3Credentials>;
  BUCKET: Cloudflare.R2.Bucket;
}>;
export const _s3Credentials: string = s3Env.S3;
export const _s3Bucket: R2Bucket = s3Env.BUCKET;
export const _s3Declared = Cloudflare.R2.S3Credentials(s3Bucket, {
  access: "write",
});
// @ts-expect-error `access` is required.
export const _s3NoAccess = Cloudflare.R2.S3Credentials(s3Bucket);
