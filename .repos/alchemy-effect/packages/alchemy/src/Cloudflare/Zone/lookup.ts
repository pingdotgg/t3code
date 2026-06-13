import {
  Credentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";

/**
 * Reference to an existing Cloudflare Zone. Accepts:
 *   - a zone id (32 hex characters),
 *   - a zone name (`example.com`), or
 *   - a `{ zoneId, name? }` object (e.g. the output of a `Zone` resource or
 *     {@link importZone}).
 */
export type ZoneReference = string | { zoneId: string; name?: string };

export const isZoneId = (zone: string): boolean => /^[a-f0-9]{32}$/i.test(zone);

export const matchesZoneHostname = (
  zoneName: string,
  hostname: string,
): boolean => hostname === zoneName || hostname.endsWith(`.${zoneName}`);

export const resolveZoneId = ({
  accountId,
  zone,
  hostname,
}: {
  accountId: string;
  zone: ZoneReference | undefined;
  hostname: string;
}) =>
  Effect.gen(function* () {
    if (typeof zone === "object") return zone.zoneId;
    if (typeof zone === "string" && isZoneId(zone)) return zone;

    const lookup = zone ?? hostname;
    for (const candidate of zoneNameCandidates(lookup)) {
      const match = yield* findZoneByName({ accountId, name: candidate });
      if (match) return match.id;
    }
    return yield* Effect.fail(
      new Error(`Cloudflare zone not found for ${lookup}`),
    );
  });

type ZoneListItem = {
  id: string;
  name: string;
  account: { id?: string | null };
};

type ZoneListResponse = {
  success: boolean;
  errors?: { message?: string }[];
  result?: ZoneListItem[];
};

export const findZoneByName = ({
  accountId,
  name,
}: {
  accountId: string;
  name: string;
}): Effect.Effect<ZoneListItem | undefined, Error, Credentials> =>
  Effect.gen(function* () {
    const credentialsEffect = yield* Credentials;
    const credentials = yield* credentialsEffect;
    const url = new URL(`${credentials.apiBaseUrl}/zones`);
    url.searchParams.set("account.id", accountId);
    url.searchParams.set("name", name);
    url.searchParams.set("per_page", "1");

    const json = yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url, {
          headers: formatHeaders(credentials),
        });
        return (await response.json()) as ZoneListResponse;
      },
      catch: (cause) => new Error(`Failed to list Cloudflare zones`, { cause }),
    });

    if (!json.success) {
      return yield* Effect.fail(
        new Error(
          json.errors?.map((error) => error.message).join(", ") ??
            `Failed to list Cloudflare zones`,
        ),
      );
    }

    return json.result?.find(
      (candidate) =>
        candidate.name === name && candidate.account.id === accountId,
    );
  });

const zoneNameCandidates = (hostname: string): string[] => {
  const parts = hostname.split(".");
  return parts.slice(0, -1).map((_, index) => parts.slice(index).join("."));
};
