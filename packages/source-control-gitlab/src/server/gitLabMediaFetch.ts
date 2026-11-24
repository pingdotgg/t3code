import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";

import { gitLabMediaUrl } from "../shared/gitLabMedia.ts";
import * as GitLabCli from "./GitLabCli.ts";

const MAX_MEDIA_BYTES = 8 * 1024 * 1024;

export const make = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const url = URL.parse(request.url);
    if (url === null || gitLabMediaUrl(url) === null || request.cwd === undefined) return null;
    const chunks: Array<Uint8Array> = [];
    const result = yield* cli
      .execute({
        cwd: request.cwd,
        callerNamedHost: url.host,
        // glab sends the host's token to a full URL on that host, not only to `/api/v4` paths.
        args: ["api", "--hostname", url.host, request.url],
        maxOutputBytes: MAX_MEDIA_BYTES,
        onStdoutChunk: (chunk) => chunks.push(chunk),
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (result === null || result.stdoutTruncated) return null;
    return HttpClientResponse.fromWeb(
      HttpClientRequest.get(request.url),
      new Response(Buffer.concat(chunks), { status: 200 }),
    );
  });
});
