import { Atom } from "effect/reactivity";

import type { ComposerAttachmentUploadState } from "../lib/composerAttachmentUploadQueue";

/** The upload worker's per-attachment states, apart from the worker so the outbox can read them. */
export const composerAttachmentUploadsAtom = Atom.make<
  Readonly<Record<string, ComposerAttachmentUploadState>>
>({}).pipe(Atom.keepAlive);
