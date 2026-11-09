import type { PreparedHttpAuthorization } from "@t3tools/client-runtime/connection";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, PluginMutationResult, type PluginState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { pluginEnvironment } from "../state/plugins";
import { readPreparedConnection } from "../state/session";
import type { PluginFolderFile } from "./pluginFolders";

// Bearer and cookie sessions can fetch plugin files directly. A DPoP proof needs the relay
// signer, which only the client runtime holds.
async function pluginFileRequestInit(
  authorization: PreparedHttpAuthorization | null,
  url: URL,
): Promise<RequestInit> {
  if (authorization === null) return { credentials: "include" };
  if (authorization._tag === "Bearer") {
    return { headers: { authorization: `Bearer ${authorization.token}` } };
  }
  const headers = await runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.pluginFileHeaders,
    { authorization, url: url.href },
    { reportFailure: false },
  );
  if (headers._tag !== "Success")
    throw new Error("Could not authorize the request over T3 Connect.");
  return { headers: { ...headers.value } };
}

class PluginFileRequestError extends Schema.TaggedError<PluginFileRequestError>()(
  "PluginFileRequestError",
  { status: Schema.Number, filePath: Schema.String },
) {
  override get message(): string {
    return `The request for ${this.filePath} failed with ${this.status}.`;
  }
}

const isPluginFileRequestError = Schema.is(PluginFileRequestError);

// A dropped connection or a gateway error, such as one bad gateway over T3 Connect, can pass.
const isPassingDownloadFailure = (error: unknown) =>
  error instanceof TypeError ||
  (isPluginFileRequestError(error) && [502, 503, 504].includes(error.status));
const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 5_000, 30_000];

// A file whose URL names its contents, such as the web bundle, is one the server lets browsers
// cache for good.
export async function fetchPluginFile(
  environmentId: EnvironmentId,
  plugin: PluginState,
  filePath: string,
  revision = plugin.version ?? "0",
): Promise<Response> {
  const connection = readPreparedConnection(environmentId);
  if (connection === null) throw new Error("The environment is not connected.");
  const authorization = connection.httpAuthorization;
  const url = new URL(
    `/api/plugins/${encodeURIComponent(plugin.id)}${filePath}`,
    connection.httpBaseUrl,
  );
  url.searchParams.set("v", revision);
  const response = await fetch(url, await pluginFileRequestInit(authorization, url));
  if (!response.ok) throw new PluginFileRequestError({ status: response.status, filePath });
  return response;
}

/** Resolves undefined when `cancelled` turns true during a wait between tries. */
export async function withDownloadRetries<A>(
  download: () => Promise<A>,
  cancelled: () => boolean,
): Promise<A | undefined> {
  for (const delay of [...DOWNLOAD_RETRY_DELAYS_MS, undefined]) {
    try {
      return await download();
    } catch (error) {
      if (delay === undefined || !isPassingDownloadFailure(error)) throw error;
      await new Promise((resume) => setTimeout(resume, delay));
      if (cancelled()) return undefined;
    }
  }
  return undefined;
}

const decodeMutationResult = Schema.decodeUnknownSync(Schema.fromJsonString(PluginMutationResult));

// The files go over HTTP to a URL the server signs, which needs no other credentials, so a large
// folder does not hold up the WebSocket.
export async function uploadPluginFolder(
  environmentId: EnvironmentId,
  files: ReadonlyArray<PluginFolderFile>,
): Promise<PluginState> {
  const minted = await runAtomCommand(
    appAtomRegistry,
    pluginEnvironment.createPluginUploadUrl,
    { environmentId, input: {} },
    { reportFailure: false },
  );
  if (minted._tag !== "Success") {
    const error = squashAtomCommandFailure(minted);
    throw error instanceof Error ? error : new Error("Could not start the upload.");
  }
  const connection = readPreparedConnection(environmentId);
  const url =
    connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, minted.value.relativeUrl);
  if (url === null) throw new Error("The environment is not connected.");
  const body = new FormData();
  // Escaped, so no browser or parser changes a path's quotes, slashes or other characters.
  for (const { path, file } of files) body.append("file", file, encodeURIComponent(path));
  const response = await fetch(url, { method: "POST", body });
  const text = await response.text();
  if (!response.ok) throw new Error(text || `The upload failed with ${response.status}.`);
  return decodeMutationResult(text).plugin;
}
