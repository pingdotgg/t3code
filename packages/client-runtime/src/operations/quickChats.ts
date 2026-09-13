import {
  ProjectId,
  type ModelSelection,
  type ServerConfig,
  type ScopedThreadRef,
  type VcsCreateWorktreeInput,
  type VcsCreateWorktreeResult,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Select an available environment default for a chat without project defaults. */
export function quickChatModelSelection(config: {
  providers: ServerConfig["providers"];
  settings: Pick<ServerConfig["settings"], "defaultModelSelection">;
}): ModelSelection | null {
  const providers = config.providers.filter(
    (provider) =>
      provider.enabled &&
      provider.status !== "error" &&
      provider.installed &&
      provider.availability !== "unavailable" &&
      provider.auth.status !== "unauthenticated",
  );
  const preferred = config.settings.defaultModelSelection;
  if (
    preferred &&
    providers.some(
      (provider) =>
        provider.instanceId === preferred.instanceId &&
        provider.models.some((model) => model.slug === preferred.model),
    )
  ) {
    return preferred;
  }
  for (const provider of providers) {
    const model =
      provider.models.find((model) => model.isDefault && !model.isLegacy) ??
      provider.models.find((model) => !model.isLegacy);
    if (model) return { instanceId: provider.instanceId, model: model.slug };
  }
  return null;
}

const PendingQuickChatAttachment = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  baseBranch: Schema.String,
  branch: Schema.String,
});
export type PendingQuickChatAttachment = typeof PendingQuickChatAttachment.Type;
const decodePendingAttachment = Schema.decodeUnknownSync(
  Schema.fromJsonString(PendingQuickChatAttachment),
);

/** Persist the intended branch before creating it so a lost response remains recoverable. */
export function createQuickChatAttachmentStorage(storage: {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void | Promise<void>;
  removeItem: (key: string) => void;
}) {
  const key = (ref: ScopedThreadRef) =>
    `t3-quick-chat-attachment-${encodeURIComponent(ref.environmentId)}/${encodeURIComponent(ref.threadId)}`;
  return {
    load(ref: ScopedThreadRef) {
      const raw = storage.getItem(key(ref));
      return raw === null ? null : decodePendingAttachment(raw);
    },
    save(ref: ScopedThreadRef, pending: PendingQuickChatAttachment) {
      return storage.setItem(key(ref), JSON.stringify(pending));
    },
    clear(ref: ScopedThreadRef) {
      storage.removeItem(key(ref));
    },
  };
}

/** Git owns the recovery record after creation; retries reuse its checked-out branch. */
export async function prepareQuickChatWorktree(input: {
  pending: PendingQuickChatAttachment;
  listRefs: () => Promise<VcsListRefsResult>;
  createWorktree: (input: VcsCreateWorktreeInput) => Promise<VcsCreateWorktreeResult>;
}): Promise<VcsCreateWorktreeResult["worktree"]> {
  const refs = await input.listRefs();
  const existing = refs.refs.find((ref) => ref.name === input.pending.branch && !ref.isRemote);
  if (existing?.worktreePath) {
    return { path: existing.worktreePath, refName: existing.name };
  }
  const result = await input.createWorktree({
    cwd: input.pending.workspaceRoot,
    refName: existing?.name ?? input.pending.baseBranch,
    ...(existing ? {} : { newRefName: input.pending.branch }),
    path: null,
  });
  return result.worktree;
}
