import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Alchemy from "alchemy";
import * as Data from "effect/Data";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "alchemy/Cloudflare";

export interface ImportedCloudflareZoneProps {
  readonly zoneId: string;
  readonly accountId?: string;
  readonly baseSubdomain?: string;
}

export interface ImportedCloudflareZoneOutput extends ImportedCloudflareZoneProps {
  readonly name: string;
  readonly accountId: string;
}

export type ImportedCloudflareZone = Alchemy.Resource<
  "T3CodeRelay.ImportedCloudflareZone",
  ImportedCloudflareZoneProps,
  ImportedCloudflareZoneOutput
>;

export const ImportedCloudflareZone = Alchemy.Resource<ImportedCloudflareZone>(
  "T3CodeRelay.ImportedCloudflareZone",
);

export class ImportedCloudflareZoneReadError extends Data.TaggedError(
  "ImportedCloudflareZoneReadError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function normalizeImportedCloudflareZone(
  input: ImportedCloudflareZoneOutput,
): ImportedCloudflareZoneOutput {
  const baseSubdomain = input.baseSubdomain?.trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/i.test(input.zoneId)) {
    throw new Error("Cloudflare zone id must be a 32 character hex string.");
  }
  if (!/^[a-f0-9]{32}$/i.test(input.accountId)) {
    throw new Error("Cloudflare account id must be a 32 character hex string.");
  }
  if (baseSubdomain !== undefined && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(baseSubdomain)) {
    throw new Error("Cloudflare managed endpoint base subdomain must be a DNS label.");
  }
  if (!input.name.trim() || input.name.includes("/")) {
    throw new Error("Cloudflare zone name must be a DNS zone name.");
  }
  return {
    zoneId: input.zoneId,
    name: input.name.trim().toLowerCase(),
    accountId: input.accountId,
    ...(baseSubdomain === undefined ? {} : { baseSubdomain }),
  };
}

type CloudflareZoneReadResponse = {
  readonly success: boolean;
  readonly errors?: ReadonlyArray<{ readonly message?: string }>;
  readonly result?: {
    readonly id?: string | null;
    readonly name?: string | null;
    readonly account?: { readonly id?: string | null };
  } | null;
};

export function readCloudflareZone(input: {
  readonly apiBaseUrl: string;
  readonly headers: HeadersInit;
  readonly zoneId: string;
}): Effect.Effect<
  ImportedCloudflareZoneOutput,
  ImportedCloudflareZoneReadError,
  HttpClient.HttpClient
> {
  return Effect.gen(function* () {
    const response = yield* HttpClient.get(`${input.apiBaseUrl}/zones/${input.zoneId}`, {
      headers: input.headers as Record<string, string>,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ImportedCloudflareZoneReadError({
            message: "Failed to read imported Cloudflare zone.",
            cause,
          }),
      ),
    );
    const json = yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new ImportedCloudflareZoneReadError({
            message: "Failed to read imported Cloudflare zone.",
            cause,
          }),
      ),
    );
    return json as CloudflareZoneReadResponse;
  }).pipe(
    Effect.flatMap((json) => {
      if (!json.success) {
        return Effect.fail(
          new ImportedCloudflareZoneReadError({
            message:
              json.errors
                ?.map((error) => error.message)
                .filter(Boolean)
                .join(", ") || "Failed to read imported Cloudflare zone.",
          }),
        );
      }
      const result = json.result;
      const name = result?.name;
      const accountId = result?.account?.id;
      if (
        result?.id !== input.zoneId ||
        !name ||
        !accountId ||
        !/^[a-f0-9]{32}$/i.test(accountId)
      ) {
        return Effect.fail(
          new ImportedCloudflareZoneReadError({
            message: "Cloudflare zone response did not include expected zone metadata.",
          }),
        );
      }

      return Effect.succeed({
        zoneId: input.zoneId,
        name,
        accountId,
      });
    }),
  );
}

export const ImportedCloudflareZoneProvider = () =>
  Provider.effect(
    ImportedCloudflareZone,
    Effect.gen(function* () {
      const credentialsEffect = yield* Credentials;
      const cloudflareEnvironment = yield* CloudflareEnvironment;

      return {
        reconcile: Effect.fn(function* ({ news }) {
          if (!/^[a-f0-9]{32}$/i.test(news.zoneId)) {
            return yield* new ImportedCloudflareZoneReadError({
              message: "Cloudflare zone id must be a 32 character hex string.",
            });
          }

          const credentials = yield* credentialsEffect;
          const zone = yield* readCloudflareZone({
            apiBaseUrl: credentials.apiBaseUrl,
            headers: formatHeaders(credentials),
            zoneId: news.zoneId,
          });
          if (
            zone.accountId !== cloudflareEnvironment.accountId ||
            (news.accountId !== undefined && news.accountId !== zone.accountId)
          ) {
            return yield* new ImportedCloudflareZoneReadError({
              message:
                "Imported Cloudflare zone belongs to a different account than the Alchemy Cloudflare credentials.",
            });
          }

          return normalizeImportedCloudflareZone({
            ...zone,
            ...(news.baseSubdomain === undefined ? {} : { baseSubdomain: news.baseSubdomain }),
          });
        }),
        delete: () => Effect.void,
        read: ({ output }) => Effect.succeed(output),
      };
    }),
  );
