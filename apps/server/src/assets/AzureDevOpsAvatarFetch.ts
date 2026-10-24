import * as Effect from "effect/Effect";
import { HttpServerResponse } from "effect/http";

import * as AzureDevOpsCli from "@t3tools/source-control-azure-devops/server/AzureDevOpsCli";
import * as HostProcess from "@t3tools/shared/HostProcess";

export const azureDevOpsAvatarResponse = Effect.fn("AzureDevOpsAvatarFetch.response")(
  function* (asset: { readonly organizationUrl: string; readonly identityId: string }) {
    const az = yield* AzureDevOpsCli.AzureDevOpsCli;
    const avatar = yield* az
      .getIdentityAvatar({
        // `--org` names the organization, so the working directory only has to exist.
        cwd: yield* HostProcess.HomeDirectory,
        identity: asset,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to fetch an Azure DevOps avatar.", {
            organizationUrl: asset.organizationUrl,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    if (avatar === null) {
      return HttpServerResponse.empty({
        status: 404,
        headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
      });
    }
    return HttpServerResponse.uint8Array(avatar.bytes, {
      contentType: avatar.mimeType,
      headers: { "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" },
    });
  },
);
