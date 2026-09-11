export type { BetterAuthApi } from "./ApiProxy.ts";
export {
  BetterAuth,
  type AuthOptions,
  type BetterAuthInstance,
  type BetterAuthProps,
  type Session,
} from "./BetterAuth.ts";
export {
  Database,
  type DatabaseInput,
  type DatabaseService,
  type DirectDatabase,
  type Provider,
} from "./Database.ts";
export {
  BetterAuthApiError,
  BetterAuthMigrationError,
  BetterAuthStorageError,
  isAPIErrorLike,
  mergeAPIErrorHeaders,
} from "./Errors.ts";
export { Memory } from "./Memory.ts";
export {
  SecondaryStorage,
  type SecondaryStorageService,
} from "./SecondaryStorage.ts";
// Driver-backed platform layers are deliberately NOT re-exported from the
// barrel (they carry optional peer deps / runtime-specific imports).
// One file per layer, one export condition per layer:
//   @alchemy.run/better-auth/CloudflareD1         — native D1 binding + HTTP migrations
//   @alchemy.run/better-auth/CloudflareHyperdrive — pooled TCP Postgres/MySQL via Hyperdrive
//   @alchemy.run/better-auth/Neon                 — Neon serverless driver (Workers/Lambda, no Hyperdrive/pg)
//   @alchemy.run/better-auth/AuroraDataApi        — Aurora over the RDS Data API (Lambda, no VPC/pg)
//   @alchemy.run/better-auth/Postgres             — generic pg TCP (Hyperdrive origin, RDS-in-VPC, literal URLs)
//   @alchemy.run/better-auth/MySQL                — generic mysql2 TCP (PlanetScale MySQL, Hyperdrive origin)
//   @alchemy.run/better-auth/SQLite               — bun:sqlite (dev/tests)
//   @alchemy.run/better-auth/Drizzle              — drizzle-orm
