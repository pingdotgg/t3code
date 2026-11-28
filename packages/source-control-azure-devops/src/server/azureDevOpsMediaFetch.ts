import * as NodeOS from "node:os";

import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { parseAzureDevOpsAvatar } from "../shared/azureDevOpsAvatar.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const MemberAvatar = Schema.Struct({
  imageData: Schema.String,
  imageType: Schema.optional(Schema.String),
});
const decodeMemberAvatar = Schema.decodeUnknownOption(Schema.fromJsonString(MemberAvatar));

/** Avatars are a few kilobytes; the cap only guards against a runaway response. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  const readAvatar = Effect.fn("AzureDevOpsMediaFetch.readAvatar")(
    function* (fetchUrl: string) {
      const url = URL.parse(fetchUrl);
      const avatar = url === null ? null : parseAzureDevOpsAvatar(url);
      if (avatar === null) return Option.none();
      // Azure serves the picture only to a signed-in request, so it goes through `az`'s login.
      const output = yield* azure.execute({
        cwd: NodeOS.tmpdir(),
        args: [
          "devops",
          "invoke",
          "--organization",
          `https://dev.azure.com/${avatar.organization}`,
          "--area",
          "GraphProfile",
          "--resource",
          "MemberAvatars",
          "--route-parameters",
          `memberDescriptor=${avatar.id}`,
          "--api-version",
          "7.1-preview",
          "--only-show-errors",
          "--output",
          "json",
        ],
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      return decodeMemberAvatar(output.stdout).pipe(
        Option.map((decoded) => ({
          bytes: Buffer.from(decoded.imageData, "base64"),
          contentType: decoded.imageType ?? "image/png",
        })),
      );
    },
    Effect.orElseSucceed(() => Option.none()),
  );

  // One list shows the same people many times, and each read starts an `az` process.
  const avatars = yield* Cache.makeWith(readAvatar, {
    capacity: 512,
    timeToLive: (exit) =>
      Exit.isSuccess(exit) && Option.isSome(exit.value) ? "1 hour" : "1 minute",
  });

  return Effect.fn("AzureDevOpsMediaFetch.fetchMedia")(function* (
    request: SourceControlMediaRequest,
  ) {
    const avatar = yield* Cache.get(avatars, request.url);
    if (Option.isNone(avatar)) return null;
    return HttpClientResponse.fromWeb(
      HttpClientRequest.get(request.url),
      new Response(avatar.value.bytes, {
        headers: {
          "content-type": avatar.value.contentType,
          "content-length": String(avatar.value.bytes.byteLength),
        },
      }),
    );
  });
});
