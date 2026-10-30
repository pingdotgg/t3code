import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as AzureDevOpsAvatarFetch from "./azureDevOpsAvatarFetch.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const ID = "15f0488e-b980-68ca-9d71-8a387c166d09";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("AzureDevOpsAvatarFetch", () => {
  it.effect("serves the avatar `az` reads for the URL the definition claimed", () => {
    const lookups: Array<unknown> = [];
    return Effect.gen(function* () {
      const fetchMedia = yield* AzureDevOpsAvatarFetch.make;
      const media = definition.mediaUrl?.(
        new URL(`https://acme.visualstudio.com/_api/_common/identityImage?id=${ID}`),
      );
      expect(media?.fetchUrl).toBeDefined();
      if (media == null) return;

      const response = yield* fetchMedia({ url: media.fetchUrl, headers: {} });
      expect(response?.status).toBe(200);
      if (response == null) return;
      expect(response.headers["content-type"]).toBe("image/png");
      expect(new Uint8Array(yield* response.arrayBuffer)).toEqual(PNG);
      expect(lookups).toEqual([
        { organizationUrl: "https://acme.visualstudio.com", identityId: ID },
      ]);

      // Azure answered without an image `az` could decode.
      const missing = yield* fetchMedia({
        url: `https://dev.azure.com/acme/_api/_common/identityImage?id=${ID}`,
        headers: {},
      });
      expect(missing?.status).toBe(404);
    }).pipe(
      Effect.provide(
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({
          getIdentityAvatar: ({ identity }) => {
            lookups.push(identity);
            return Effect.succeed(
              identity.organizationUrl === "https://acme.visualstudio.com"
                ? { bytes: PNG, mimeType: "image/png" as const }
                : null,
            );
          },
        }),
      ),
    );
  });
});
