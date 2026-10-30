import * as HostProcess from "@t3tools/shared/HostProcess";
import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { azureDevOpsAvatarIdentity } from "../shared/azureDevOpsAvatar.ts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

export const make = Effect.gen(function* () {
  const az = yield* AzureDevOpsCli.AzureDevOpsCli;

  return Effect.fn("AzureDevOpsAvatarFetch.fetchMedia")(function* (
    request: SourceControlMediaRequest,
  ) {
    const identity = azureDevOpsAvatarIdentity(request.url);
    if (identity === null) return null;
    const avatar = yield* az
      .getIdentityAvatar({
        // `--org` names the organization, so the working directory only has to exist.
        cwd: yield* HostProcess.HomeDirectory,
        identity,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to fetch an Azure DevOps avatar.", {
            organizationUrl: identity.organizationUrl,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    // `az` hands back the whole image, so there is no upstream response to stream through.
    const response =
      avatar === null
        ? new Response(null, { status: 404 })
        : new Response(new Blob([new Uint8Array(avatar.bytes)], { type: avatar.mimeType }));
    return HttpClientResponse.fromWeb(HttpClientRequest.get(request.url), response);
  });
});
