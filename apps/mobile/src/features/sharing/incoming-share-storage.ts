import * as Schema from "effect/Schema";
import type { File } from "expo-file-system";

import { decodeIncomingShareDraft, type IncomingShareDraft } from "./incoming-share-model";

const INCOMING_SHARE_DIRECTORY = "incoming-shares";

export class IncomingShareStorageError extends Schema.TaggedError<IncomingShareStorageError>()(
  "IncomingShareStorageError",
  {
    operation: Schema.Literals(["load", "write", "remove"]),
    shareId: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Incoming share storage operation ${this.operation} failed for ${this.shareId ?? "unknown"}.`;
  }
}

function fileName(shareId: string): string {
  return `${encodeURIComponent(shareId)}.json`;
}

async function getDirectory() {
  const { Directory, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, INCOMING_SHARE_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

async function getFile(shareId: string, suffix = "") {
  const { File } = await import("expo-file-system");
  return new File(await getDirectory(), `${fileName(shareId)}${suffix}`);
}

async function readSavedDraft(file: File) {
  try {
    return { file, draft: decodeIncomingShareDraft(JSON.parse(await file.text()) as unknown) };
  } catch (cause) {
    const { File } = await import("expo-file-system");
    const backup = new File(file.parentDirectory, `${file.name}.bak`);
    if (!backup.exists) throw cause;
    return {
      file: backup,
      draft: decodeIncomingShareDraft(JSON.parse(await backup.text()) as unknown),
    };
  }
}

export async function loadIncomingShareDrafts(options?: {
  readonly strict?: boolean;
}): Promise<ReadonlyArray<IncomingShareDraft>> {
  try {
    const { File } = await import("expo-file-system");
    const drafts: IncomingShareDraft[] = [];
    for (const entry of (await getDirectory()).list()) {
      if (!(entry instanceof File)) continue;
      if (entry.name.endsWith(".json.bak")) {
        if (new File(entry.parentDirectory, entry.name.slice(0, -4)).exists) continue;
      } else if (!entry.name.endsWith(".json")) {
        continue;
      }
      try {
        drafts.push((await readSavedDraft(entry)).draft);
      } catch (cause) {
        const error = new IncomingShareStorageError({ operation: "load", shareId: null, cause });
        if (options?.strict) {
          throw error;
        }
        console.warn("[incoming-share] ignored invalid persisted share", error);
      }
    }
    return drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (cause) {
    if (cause instanceof IncomingShareStorageError) {
      throw cause;
    }
    throw new IncomingShareStorageError({ operation: "load", shareId: null, cause });
  }
}

export async function writeIncomingShareDraft(draft: IncomingShareDraft): Promise<void> {
  try {
    const file = await getFile(draft.id);
    const backup = await getFile(draft.id, ".bak");
    const temp = await getFile(draft.id, ".tmp");
    // Inbox mutations are serialized, so each share can reuse its staging path.
    temp.create({ intermediates: true, overwrite: true });
    await temp.write(JSON.stringify(draft));
    // Expo can remove or partially copy the destination before a move fails.
    if (file.exists) {
      const saved = await readSavedDraft(file).catch(() => undefined);
      if (!saved || saved.file === file) file.copySync(backup, { overwrite: true });
    }
    temp.moveSync(file, { overwrite: true });
    try {
      if (backup.exists) backup.delete();
    } catch {
      // The installed JSON is authoritative even if backup cleanup fails.
    }
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "write", shareId: draft.id, cause });
  }
}

export async function removeIncomingShareDraft(shareId: string): Promise<void> {
  try {
    // Delete the backup first so a failed removal cannot resurrect a consumed share.
    for (const suffix of [".tmp", ".bak", ""]) {
      const file = await getFile(shareId, suffix);
      if (file.exists) file.delete();
    }
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "remove", shareId, cause });
  }
}
