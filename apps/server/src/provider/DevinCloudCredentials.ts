import type { DevinCloudSettings } from "@t3tools/contracts";
import * as NodeOS from "node:os";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/unstable/http";

import { DevinCloudApiError, makeDevinCloudApi } from "./DevinCloudApi.ts";

// The Devin CLI persists its browser sign-in credential in credentials.toml
// after `devin` login. Reusing it lets Devin Cloud work without a separate
// service-user API key when the CLI is signed in on the server machine.
const CLI_CREDENTIALS_KEY_PATTERN = /^windsurf_api_key\s*=\s*"([^"]+)"/mu;

const DevinCloudSelfOrganization = Schema.Struct({ org_id: Schema.String });
const decodeSelfOrganization = Schema.decodeUnknownEffect(DevinCloudSelfOrganization);

export interface ResolvedDevinCloudCredentials {
  readonly settings: DevinCloudSettings;
  readonly source: "settings" | "devin-cli";
}

export function parseDevinCliApiKey(credentialsToml: string): Option.Option<string> {
  const match = CLI_CREDENTIALS_KEY_PATTERN.exec(credentialsToml);
  return match?.[1] ? Option.some(match[1]) : Option.none();
}

export const readDevinCliApiKey: Effect.Effect<
  Option.Option<string>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const xdgDataHome = yield* Config.option(Config.string("XDG_DATA_HOME")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const appData = yield* Config.option(Config.string("APPDATA")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  const dataHome = Option.getOrElse(xdgDataHome, () =>
    path.join(NodeOS.homedir(), ".local", "share"),
  );
  // The Devin CLI writes credentials.toml under XDG data on Linux/macOS and
  // under %APPDATA% on Windows; probe both so a Windows sign-in is found.
  const candidates = [
    path.join(dataHome, "devin", "credentials.toml"),
    ...(Option.isSome(appData) ? [path.join(appData.value, "devin", "credentials.toml")] : []),
  ];
  for (const candidate of candidates) {
    const key = yield* fs.readFileString(candidate).pipe(
      Effect.map(parseDevinCliApiKey),
      Effect.orElseSucceed(() => Option.none<string>()),
    );
    if (Option.isSome(key)) return key;
  }
  return Option.none<string>();
});

/**
 * Fills missing Devin Cloud credentials from the Devin CLI sign-in: the API
 * key comes from the CLI's stored credential and the organization ID from
 * `/self`. Explicit settings always win. Returns none when no credential
 * exists anywhere; fails when a credential exists but the organization
 * lookup is rejected.
 */
export const resolveDevinCloudCredentials = Effect.fn("DevinCloudCredentials.resolve")(function* (
  settings: DevinCloudSettings,
): Effect.fn.Return<
  Option.Option<ResolvedDevinCloudCredentials>,
  DevinCloudApiError,
  FileSystem.FileSystem | HttpClient.HttpClient | Path.Path
> {
  if (settings.apiKey && settings.organizationId) {
    return Option.some({ settings, source: "settings" as const });
  }
  const apiKey = settings.apiKey || Option.getOrUndefined(yield* readDevinCliApiKey);
  if (!apiKey) return Option.none();
  const source = settings.apiKey ? ("settings" as const) : ("devin-cli" as const);

  let organizationId = settings.organizationId;
  if (!organizationId) {
    const self = yield* (yield* makeDevinCloudApi({ ...settings, apiKey })).getSelf;
    const decoded = yield* decodeSelfOrganization(self).pipe(
      Effect.mapError(
        (cause) =>
          new DevinCloudApiError({
            operation: "getSelf",
            detail: "The sign-in has no organization. Set the organization ID explicitly.",
            cause,
          }),
      ),
    );
    organizationId = decoded.org_id;
  }
  return Option.some({ settings: { ...settings, apiKey, organizationId }, source });
});
