import * as Schema from "effect/Schema";

import { decodeIncomingShareDraft, type IncomingShareDraft } from "./incoming-share-model";

const INCOMING_SHARE_DIRECTORY = "incoming-shares";

export class IncomingShareStorageError extends Schema.TaggedErrorClass<IncomingShareStorageError>()(
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

async function getFile(shareId: string) {
  const { File } = await import("expo-file-system");
  return new File(await getDirectory(), fileName(shareId));
}

export async function loadIncomingShareDrafts(): Promise<ReadonlyArray<IncomingShareDraft>> {
  try {
    const { File } = await import("expo-file-system");
    const drafts: IncomingShareDraft[] = [];
    for (const entry of (await getDirectory()).list()) {
      if (!(entry instanceof File) || !entry.name.endsWith(".json")) {
        continue;
      }
      try {
        drafts.push(decodeIncomingShareDraft(JSON.parse(await entry.text()) as unknown));
      } catch (cause) {
        console.warn(
          "[incoming-share] ignored invalid persisted share",
          new IncomingShareStorageError({ operation: "load", shareId: null, cause }),
        );
      }
    }
    return drafts.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "load", shareId: null, cause });
  }
}

export async function writeIncomingShareDraft(draft: IncomingShareDraft): Promise<void> {
  try {
    const file = await getFile(draft.id);
    if (!file.exists) {
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(JSON.stringify(draft));
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "write", shareId: draft.id, cause });
  }
}

export async function removeIncomingShareDraft(shareId: string): Promise<void> {
  try {
    const file = await getFile(shareId);
    if (file.exists) {
      file.delete();
    }
  } catch (cause) {
    throw new IncomingShareStorageError({ operation: "remove", shareId, cause });
  }
}
