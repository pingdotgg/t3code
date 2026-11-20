import type { MouseEvent } from "react";
import {
  AuthOrchestrationOperateScope,
  AuthPreviewOperateScope,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { msg, useGT } from "gt-react";
import { m } from "~/i18n/messages";
import { recordVisitForThread } from "~/browserHistoryStore";
import { contextMenuSourceOf } from "~/contextMenuSource";
import { readLocalApi } from "~/localApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { usePullRequestLinking } from "~/hooks/usePullRequestLinking";
import { readThreadShell } from "~/state/entities";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { isPreviewAvailableFor } from "~/browser/previewRuntime";
import {
  openUrlInPreview,
  BrowserPreviewUnavailableError,
  isBrowserSettingsReadError,
} from "~/browser/openFileInPreview";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { showExternalLinkContextMenu } from "./externalLinkContextMenu";

export function useExternalLinkActions(threadRef?: ScopedThreadRef) {
  const gt = useGT();
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const canOperatePreview = useEnvironmentScope(
    threadRef?.environmentId ?? null,
    AuthPreviewOperateScope,
  );
  const pullRequestLinking = usePullRequestLinking(threadRef?.environmentId);
  const openExternalLinkInPreview = (url: string) => {
    if (!threadRef || !canOperatePreview) {
      return Promise.resolve(
        AsyncResult.failure<void, BrowserPreviewUnavailableError>(
          Cause.fail(
            new BrowserPreviewUnavailableError({
              message: gt("Preview access is unavailable for this client."),
            }),
          ),
        ),
      );
    }
    return openUrlInPreview({ threadRef, url, openPreview }).then((result) => {
      if (result._tag === "Success") recordVisitForThread(threadRef, url);
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        if (isBrowserSettingsReadError(error)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: gt("Unable to open link in browser"),
              description: error.message,
            }),
          );
        }
      }
      return result;
    });
  };
  const showLinkMenu = (event: MouseEvent, href: string) => {
    event.preventDefault();
    event.stopPropagation();
    const api = readLocalApi();
    if (!api) return;
    const source = contextMenuSourceOf(event);
    const thread = threadRef ? readThreadShell(threadRef) : null;
    const threadLinkAction =
      thread &&
      threadRef &&
      readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope) &&
      pullRequestLinking.canLink(href)
        ? pullRequestLinking.isLinked(thread, href)
          ? "unlink-from-thread"
          : "link-to-thread"
        : undefined;
    void showExternalLinkContextMenu({
      href,
      canOpenInPreview:
        !!threadRef && canOperatePreview && isPreviewAvailableFor(threadRef.environmentId),
      threadLinkAction,
      position: { x: event.clientX, y: event.clientY },
      showContextMenu: (items, position) => api.contextMenu.show(items, position, source),
      openInPreview: async (target) => {
        const result = await openExternalLinkInPreview(target);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          reportMarkdownActionFailure({ operation: "open-link-in-preview", target }, result.cause);
        }
      },
      openExternal: (target) => api.shell.openExternal(target),
      copyLink: (target) =>
        writeTextToClipboard(target, {
          target: "link",
          unavailableMessage: msg("Clipboard API is unavailable while copying link."),
          failureMessage: msg("Failed to copy link to the clipboard."),
        }),
      updateThreadLink: async (url, linked) => {
        if (
          !threadRef ||
          !readEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope)
        )
          return;
        if (!linked && !pullRequestLinking.isLinked(readThreadShell(threadRef), url)) return;
        await pullRequestLinking.changeLink(threadRef, url, linked);
      },
      reportFailure: (operation, cause) => {
        reportMarkdownActionFailure({ operation, target: href }, cause);
        if (
          operation === "link-pull-request-to-thread" ||
          operation === "unlink-pull-request-from-thread"
        ) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title:
                operation === "link-pull-request-to-thread"
                  ? gt("Unable to link pull request")
                  : gt("Unable to unlink pull request"),
              description: thrownErrorMessage(cause, m) ?? gt("The request failed."),
            }),
          );
        }
      },
    });
  };
  return { openExternalLinkInPreview, showLinkMenu };
}
