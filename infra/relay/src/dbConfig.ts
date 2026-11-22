import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { literalConfig } from "./Config.ts";

export type RelayDatabaseMode = "shared-database" | "stage-branch" | "external";

export const RelayDatabaseProvider = Schema.Literals(["planetscale", "external"]);
export type RelayDatabaseProvider = typeof RelayDatabaseProvider.Type;

export const relayDatabaseProviderConfig = literalConfig(
  "RELAY_DATABASE_PROVIDER",
  RelayDatabaseProvider,
  "planetscale",
);

export class ExternalDatabaseStageError extends Schema.TaggedError<ExternalDatabaseStageError>()(
  "ExternalDatabaseStageError",
  { stage: Schema.String },
) {
  override get message(): string {
    return `RELAY_DATABASE_PROVIDER=external deploys only the prod stage, not '${this.stage}': an external database has no per-stage branches, and another stage would migrate and write production data.`;
  }
}

export function relayDatabaseMode(
  stage: string,
  provider: RelayDatabaseProvider = "planetscale",
): RelayDatabaseMode {
  if (provider === "external") {
    if (stage !== "prod") throw new ExternalDatabaseStageError({ stage });
    return "external";
  }
  return stage === "prod" ? "shared-database" : "stage-branch";
}

export class InvalidRelayDatabaseUrlError extends Schema.TaggedError<InvalidRelayDatabaseUrlError>()(
  "InvalidRelayDatabaseUrlError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `RELAY_DATABASE_URL is not a usable Postgres URL: ${this.reason}.`;
  }
}

export interface ExternalDatabaseOrigin {
  readonly scheme: "postgres";
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: Redacted.Redacted<string>;
}

/** Errors never echo the URL: it carries the password. */
export function parseRelayDatabaseUrl(url: Redacted.Redacted<string>): ExternalDatabaseOrigin {
  const invalid = (reason: string) => new InvalidRelayDatabaseUrlError({ reason });
  let parsed: URL;
  try {
    parsed = new URL(Redacted.value(url).trim());
  } catch {
    throw invalid("it does not parse as a URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw invalid("the scheme must be postgres:// or postgresql://");
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ""));
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!parsed.hostname) throw invalid("it has no host");
  if (!database) throw invalid("it names no database");
  if (!user || !password) throw invalid("it has no user and password");
  return {
    scheme: "postgres",
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 5432,
    database,
    user,
    password: Redacted.make(password),
  };
}
