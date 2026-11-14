// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type BrowserRecordingFrameRate,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import type { CDPSession, ConsoleMessage, Frame, Locator, Page } from "playwright-core";
import * as NodeCrypto from "node:crypto";
import { BrowserControlInterrupted } from "./SessionControl.ts";
import { openReaders } from "./ServerBrowserPageParts2.ts";
import type { SnapshotInput } from "./ServerBrowserPage.ts";
import { MASKED_VALUE, MAX_SCREENSHOT_WIDTH, MAX_VISIBLE_TEXT_LENGTH, SNAPSHOT_SCRIPT, captureViewport, dottedPattern, invalidateRefs, maskTree, pageChanged, pngSize, refsFor, renderingOf, shrinkPng, tooBusy, withoutDataPayload, withoutTreeDataPayloads } from "./ServerBrowserPage.ts";

export const capture = async (
  input: SnapshotInput,
  deadline: number,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport } = await renderingOf(input);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const { readers, read } = await openReaders(input.page, input.cdp);
  const before = await read();
  // Bracket the tree with value reads to detect changes; await tree completion before retrying failed captures.
  const pageAndScreenshot = Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >,
    captureViewport(input.cdp, { format: "png" }).then((png) =>
      scale < 1 ? shrinkPng(input.cdp, png, scale) : png,
    ),
  ]);
  void pageAndScreenshot.catch(constVoid);
  // Leaves time for the second read; a frame that never loads holds the tree until then.
  const tree = await input.page.ariaSnapshot({
    mode: "ai",
    boxes: true,
    timeout: Math.max(1, deadline - Date.now() - 2_000),
  });
  const after = await read(before);
  // A value that changed meanwhile may be in the tree under neither reading.
  if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
    throw pageChanged();
  const dotted = dottedPattern(after.flatMap((values) => values ?? []));
  // Unread frames can expose values only if their content appears in the tree.
  const unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
  const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
  for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
    const iframe = await input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
    if (!iframe) throw pageChanged();
    const frame = await iframe.contentFrame();
    void iframe.dispose().catch(constVoid);
    if (frame && unread.includes(frame)) throw tooBusy();
  }
  const [page, data] = await pageAndScreenshot;
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted ? text.replace(dotted, MASKED_VALUE) : text);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const accessibilityTree = (dotted ? maskTree(redacted, dotted) : redacted)
    .slice(0, MAX_VISIBLE_TEXT_LENGTH)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    url: withoutDataPayload(page.url),
    // Mask text before truncating so a value crossing the cut cannot leak its prefix.
    visibleText: mask(page.visibleText).slice(0, MAX_VISIBLE_TEXT_LENGTH),
    accessibilityTree,
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    screenshot: {
      mimeType: "image/png",
      data,
      ...pngSize(data),
    },
  };
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
