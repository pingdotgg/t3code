import * as Effect from "effect/Effect";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import type { SourceControlMediaRequest } from "@t3tools/source-control-core/server/driver";

import { gitLabRawFile } from "../shared/gitLabMedia.ts";
import * as GitLabCli from "./GitLabCli.ts";

const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

export const make = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;

  return Effect.fn("GitLabMediaFetch.fetchMedia")(function* (request: SourceControlMediaRequest) {
    const file = URL.canParse(request.url) ? gitLabRawFile(new URL(request.url)) : null;
    if (file === null || request.cwd === undefined) return null;
    const chunks: Array<Uint8Array> = [];
    let retainedBytes = 0;
    const result = yield* cli
      .execute({
        cwd: request.cwd,
        callerNamedHost: file.host,
        args: [
          "api",
          "--hostname",
          file.host,
          // `lfs=true` answers with a Git LFS file's object instead of its pointer.
          `projects/${encodeURIComponent(file.projectPath)}/repository/files/${encodeURIComponent(file.path)}/raw?ref=${file.sha}&lfs=true`,
        ],
        maxOutputBytes: MAX_MEDIA_BYTES,
        onStdoutChunk: (chunk) => {
          if (retainedBytes + chunk.byteLength > MAX_MEDIA_BYTES) return;
          retainedBytes += chunk.byteLength;
          chunks.push(chunk);
        },
      })
      .pipe(Effect.orElseSucceed(() => null));
    if (result === null || result.stdoutTruncated) return null;
    return HttpClientResponse.fromWeb(
      HttpClientRequest.get(request.url),
      new Response(Buffer.concat(chunks), { status: 200 }),
    );
  });
});
