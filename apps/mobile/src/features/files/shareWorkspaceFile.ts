import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

export type CreateAssetUrlRunner = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly resource: AssetResource };
}) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;

const SHARE_CACHE_DIRECTORY = "workspace-file-shares";

export class WorkspaceFileShareInterrupted extends Error {}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "An error occurred.";
}

/**
 * Downloads a workspace file through a signed asset URL into the app cache and
 * hands it to the OS share sheet (Save to Files, AirDrop, other apps).
 * Throws with a user-presentable message; throws WorkspaceFileShareInterrupted
 * when the underlying request was interrupted and no feedback is warranted.
 */
export async function shareWorkspaceFile(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: CreateAssetUrlRunner;
}): Promise<void> {
  const assetResult = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "workspace-file-download",
        threadId: input.threadId,
        path: input.path,
      },
    },
  });
  if (assetResult._tag === "Failure") {
    if (isAtomCommandInterrupted(assetResult)) {
      throw new WorkspaceFileShareInterrupted();
    }
    throw new Error(failureMessage(squashAtomCommandFailure(assetResult)));
  }
  const url = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  if (url === null) {
    throw new Error("The environment returned an invalid asset URL.");
  }

  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.cache, SHARE_CACHE_DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  const fileName = input.path.split(/[\\/]/).pop() ?? "download";
  const target = new File(directory, fileName);
  if (target.exists) {
    target.delete();
  }
  const downloaded = await File.downloadFileAsync(url, target);

  const Sharing = await import("expo-sharing");
  await Sharing.shareAsync(downloaded.uri);
}
