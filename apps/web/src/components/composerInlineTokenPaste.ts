import { ComposerContextId } from "@t3tools/contracts";
import type {
  ComposerContextClipboardFragment,
  ComposerContextRecord,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
  decodeComposerContextClipboardHtml,
} from "@t3tools/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  threadLinkContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { externalLinkContextReferences } from "@t3tools/shared/composerContextExternalLinks";
import type { EnvironmentId } from "@t3tools/contracts";

import { readThreadShell } from "~/state/entities";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";

const threadTitle = (ref: ScopedThreadRef) => readThreadShell(ref)?.title;

function localEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(primaryEnvironmentIdAtom);
}

export type PastedComposerContextOptions = {
  /** Labs mention index: rewrite pasted Jira/Figma/GitHub issue URLs into chips. */
  readonly rewriteExternalLinks?: boolean;
};

/** Pasted thread links count as context too, so they become chips like a copied chip does. */
export function readPastedComposerContext(
  clipboardData: Pick<DataTransfer, "getData">,
  options?: PastedComposerContextOptions,
): ComposerContextClipboardFragment | null {
  const rewriteExternalLinks = options?.rewriteExternalLinks === true;
  const pastedText = clipboardData.getData("text/plain");
  const decodedFragment =
    decodeComposerContextFragment(clipboardData.getData(COMPOSER_CONTEXT_CLIPBOARD_MIME)) ??
    decodeComposerContextClipboardHtml(clipboardData.getData("text/html"));
  const threads = threadLinkContextReferences(
    pastedText,
    decodedFragment?.records ?? [],
    threadTitle,
  );
  const external = rewriteExternalLinks
    ? externalLinkContextReferences(threads.text)
    : { text: threads.text, records: [] as ComposerContextRecord[] };
  const localId = localEnvironmentId();
  const source =
    decodedFragment?.source ??
    (threads.records[0]
      ? { environmentId: threads.records[0].environmentId }
      : external.records[0] && localId !== null
        ? { environmentId: localId }
        : null);
  if (source === null || source.environmentId == null) return null;
  const pastedIds = new Set<string>(
    collectComposerContextReferences(external.text).map((occurrence) => occurrence.contextId),
  );
  const records = new Map<string, ComposerContextRecord>();
  for (const record of [
    ...(decodedFragment?.records ?? []),
    ...threads.records,
    ...external.records,
  ]) {
    if (
      record.kind === "preview-annotation" &&
      !("payload" in record) &&
      pastedIds.has(record.contextId) &&
      record.screenshotContextId
    ) {
      pastedIds.add(record.screenshotContextId);
    }
    records.set(record.contextId, record);
  }
  return {
    version: 1,
    source,
    records: [...records.values()].filter((record) => pastedIds.has(record.contextId)),
  };
}

export function importPastedComposerText(
  clipboardData: Pick<DataTransfer, "getData">,
  importContextFragment?: (
    fragment: ComposerContextClipboardFragment,
  ) => ReadonlyMap<string, string>,
  options?: PastedComposerContextOptions,
): string {
  const rewriteExternalLinks = options?.rewriteExternalLinks === true;
  const pastedText = clipboardData.getData("text/plain");
  const fragment = importContextFragment ? readPastedComposerContext(clipboardData, options) : null;
  const rewrittenIds =
    fragment && fragment.records.length > 0 ? importContextFragment!(fragment) : null;
  if (!rewrittenIds || rewrittenIds.size === 0) return pastedText;
  const nextId = (contextId: string) => {
    const id = rewrittenIds.get(contextId);
    return id ? ComposerContextId.make(id) : undefined;
  };
  const text = replaceComposerContextReferences(pastedText, (occurrence) => {
    const contextId = nextId(occurrence.contextId);
    return contextId
      ? formatComposerContextReference({
          ...occurrence,
          contextId,
          kind: occurrence.kind === "element" ? "preview-annotation" : occurrence.kind,
        })
      : occurrence.source;
  });
  // A thread the import refused, on a machine this agent cannot read, stays the link it was.
  const withThreads = threadLinkContextReferences(
    text,
    fragment?.records ?? [],
    threadTitle,
    (record) => nextId(record.contextId),
  ).text;
  return rewriteExternalLinks
    ? externalLinkContextReferences(withThreads, (record) => nextId(record.contextId)).text
    : withThreads;
}
