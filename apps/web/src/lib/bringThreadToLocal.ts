import {
  createSessionTransferAtoms,
  runSessionTransfer,
} from "@t3tools/client-runtime/state/session-transfer";
import {
  runAtomCommand,
  executeAtomQuery,
  squashAtomCommandFailure,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  runAttachmentUploadCycle,
  deletePendingAttachmentUpload,
} from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  SESSION_TRANSFER_MAX_BYTES,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { newMessageId } from "./utils";
import { toastManager } from "../components/ui/toast";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";
import { assetEnvironment } from "../state/assets";
import { attachmentEnvironment } from "../state/attachments";
import { threadEnvironment } from "../state/threads";
import { readLocalApi } from "../localApi";
import { isElectron } from "../env";

const transfer = createSessionTransferAtoms(connectionAtomRuntime);
const active = new Set<string>();
export function localTransferDestination(sourceId: EnvironmentId): EnvironmentId | null {
  const source = appAtomRegistry.get(serverEnvironment.configValueAtom(sourceId));
  if (!source?.environment.capabilities.sessionTransfer) return null;
  if (!readEnvironmentScope(sourceId, AuthOrchestrationOperateScope)) return null;
  for (const [id, entry] of appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries) {
    if (id === sourceId || !entry.enabled || entry.target._tag !== "PrimaryConnectionTarget")
      continue;
    const hostname = new URL(entry.target.httpBaseUrl).hostname;
    if (!isElectron && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)) continue;
    if (
      readPreparedConnection(id) &&
      readEnvironmentScope(id, AuthOrchestrationOperateScope) &&
      appAtomRegistry.get(serverEnvironment.configValueAtom(id))?.environment.capabilities
        .sessionTransfer
    )
      return id;
  }
  return null;
}
async function command<W, A, E>(atom: AtomCommand<W, A, E>, input: W): Promise<A> {
  const result = await runAtomCommand(appAtomRegistry, atom, input, { reportFailure: false });
  if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  return result.value;
}
function url(environmentId: EnvironmentId, relativeUrl: string) {
  const connection = readPreparedConnection(environmentId);
  const resolved = connection && resolveAssetUrl(connection.httpBaseUrl, relativeUrl);
  if (!resolved) throw new Error("The environment disconnected during transfer.");
  return resolved;
}

export async function bringThreadToLocal(source: ScopedThreadRef, model: ModelSelection) {
  const destination = localTransferDestination(source.environmentId);
  if (!destination) throw new Error("Connect a local T3 server that supports transfers first.");
  const key = `${source.environmentId}/${source.threadId}`;
  if (active.has(key)) throw new Error("This thread is already being transferred.");
  const sourceConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(source.environmentId));
  const localConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(destination));
  const driver = sourceConfig?.providers.find((p) => p.instanceId === model.instanceId)?.driver;
  const provider = localConfig?.providers.find(
    (p) =>
      p.driver === driver &&
      p.enabled &&
      p.installed &&
      p.status === "ready" &&
      p.availability !== "unavailable" &&
      p.models.some((m) => m.slug === model.model),
  );
  if (!provider)
    throw new Error(
      "Configure the same provider and model locally before bringing this thread to local.",
    );
  const localModel = { ...model, instanceId: provider.instanceId };
  const confirmed = await readLocalApi()?.dialogs.confirm(
    `Bring this remote thread to local using ${provider.displayName ?? provider.driver} / ${model.model}?\n\nCopies project files, including ignored configuration such as .env, and conversation context into a new local project. Skips untracked node_modules, .t3, .next and .cache directories. Limit: 100 MB. Symbolic links and nested repositories are not supported.\n\nThe remote thread must be idle. It will be stopped only after the local copy and thread are ready. Its history and files will remain available. Dependencies and dev servers need local setup.`,
  );
  if (!confirmed) return null;
  if (active.has(key)) throw new Error("This thread is already being transferred.");
  active.add(key);
  const progressToast = toastManager.add({
    title: "Bringing thread to local",
    description: "Copying project files and conversation. Keep both environments connected.",
    timeout: 0,
  });
  let remoteAttachment: string | null = null;
  let localAttachment: string | null = null;
  try {
    return await runSessionTransfer({
      capture: async () => {
        const archive = await command(transfer.export, {
          environmentId: source.environmentId,
          input: { threadId: source.threadId },
        });
        remoteAttachment = archive.attachmentId;
        return archive;
      },
      prepareLocal: async (archive) => {
        const asset = await executeAtomQuery(
          appAtomRegistry,
          assetEnvironment.createUrl({
            environmentId: source.environmentId,
            input: { resource: { _tag: "attachment", attachmentId: archive.attachmentId } },
          }),
          { reportFailure: false },
        );
        if (asset._tag !== "Success") throw squashAtomCommandFailure(asset);
        const response = await fetch(url(source.environmentId, asset.value.relativeUrl), {
          signal: AbortSignal.timeout(5 * 60_000),
        });
        if (!response.ok) throw new Error("The remote project download failed.");
        const bytes = await response.blob();
        if (bytes.size !== archive.sizeBytes || bytes.size > SESSION_TRANSFER_MAX_BYTES)
          throw new Error("The remote project download was incomplete or too large.");
        const upload = await runAttachmentUploadCycle({
          registry: appAtomRegistry,
          createUploadUrl: attachmentEnvironment.createUploadUrl,
          remove: attachmentEnvironment.remove,
          environmentId: destination,
          upload: {
            type: "file",
            name: "remote-project.bin",
            mimeType: "application/octet-stream",
            sizeBytes: bytes.size,
          },
          resolveUploadUrl: (relative) => url(destination, relative),
          onMinted: (id) => {
            localAttachment = id;
            return "continue";
          },
          transport: (target) => {
            const controller = new AbortController();
            return {
              abort: () => controller.abort(),
              done: fetch(target, {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: bytes,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]),
              }).then((result) => {
                if (!result.ok) throw new Error("The local project upload failed.");
              }),
            };
          },
        });
        if (upload.status !== "uploaded")
          throw new Error("The local project upload failed. The remote thread was not stopped.");
        return command(transfer.import, {
          environmentId: destination,
          input: { attachmentId: upload.attachmentId, modelSelection: localModel },
        });
      },
      stopRemote: (archive) =>
        command(transfer.finish, {
          environmentId: source.environmentId,
          input: { threadId: source.threadId, transferId: archive.transferId },
        }),
      startLocal: async (local) => {
        await command(threadEnvironment.startTurn, {
          environmentId: destination,
          input: {
            threadId: local.threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: local.contextPrompt,
              attachments: [],
            },
            modelSelection: localModel,
            runtimeMode: local.runtimeMode,
            interactionMode: local.interactionMode,
          },
        });
      },
    }).then((result) => ({ ...result, environmentId: destination }));
  } finally {
    active.delete(key);
    toastManager.close(progressToast);
    if (remoteAttachment)
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId: source.environmentId,
        attachmentId: remoteAttachment,
      });
    if (localAttachment)
      deletePendingAttachmentUpload({
        registry: appAtomRegistry,
        remove: attachmentEnvironment.remove,
        environmentId: destination,
        attachmentId: localAttachment,
      });
  }
}
