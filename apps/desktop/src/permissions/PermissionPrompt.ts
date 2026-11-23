import { appLinkUrl } from "@t3tools/shared/appLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { BrowserWindow } from "electron";
import { msg } from "gt-i18n";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import { m } from "../i18n/messages.ts";

const MAX_PROMPT_TEXT_LENGTH = 300;

export const truncateForPrompt = (text: string): string =>
  text.length > MAX_PROMPT_TEXT_LENGTH ? `${text.slice(0, MAX_PROMPT_TEXT_LENGTH)}…` : text;

export interface PermissionQuestion {
  readonly buttons: readonly [allow: string, deny: string];
  readonly message: string;
  readonly detail?: string;
}

/** Native questions a page or a frame's content asks the user, one at a time. */
export class PermissionPrompt extends Context.Service<
  PermissionPrompt,
  {
    /** `undefined` when the user gave no answer: another prompt was open or the dialog failed. */
    readonly ask: (
      owner: BrowserWindow | undefined,
      question: PermissionQuestion,
    ) => Effect.Effect<boolean | undefined>;
    /** Asks before the OS opens an app link; false for anything that is not one. */
    readonly confirmAppLink: (
      owner: BrowserWindow | undefined,
      rawUrl: string | undefined,
    ) => Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/permissions/PermissionPrompt") {}

const make = Effect.gen(function* PermissionPromptMake() {
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const platform = yield* HostProcess.Platform;
  // One prompt at a time, so a page cannot stack dialogs by looping a deep link.
  let open = false;
  const ask = Effect.fn("PermissionPrompt.ask")(function* (
    owner: BrowserWindow | undefined,
    question: PermissionQuestion,
  ) {
    if (open) return undefined;
    open = true;
    return yield* electronDialog
      .showMessageBox(
        {
          type: "question",
          buttons: [...question.buttons],
          // Default to deny so an Enter typed into the page cannot accept a prompt it raised.
          defaultId: 1,
          cancelId: 1,
          message: question.message,
          ...(question.detail === undefined ? {} : { detail: question.detail }),
        },
        platform === "win32" ? undefined : owner,
      )
      .pipe(
        Effect.map(({ response }): boolean | undefined => response === 0),
        Effect.orElseSucceed(() => undefined),
        Effect.ensuring(Effect.sync(() => (open = false))),
      );
  });
  const confirmAppLink = Effect.fn("PermissionPrompt.confirmAppLink")(function* (
    owner: BrowserWindow | undefined,
    rawUrl: string | undefined,
  ) {
    const url = rawUrl === undefined ? null : appLinkUrl(rawUrl);
    if (url === null) return false;
    const answer = yield* ask(owner, {
      buttons: [
        m(msg("Open", { $context: "button, opens a link in another app" })),
        m(msg("Cancel")),
      ],
      message: m(msg("Open this {protocol} link?"), {
        protocol: new URL(url).protocol.slice(0, -1),
      }),
      detail: m(msg("A page in the browser wants to open another application:\n\n{url}"), {
        url: truncateForPrompt(url),
      }),
    });
    return answer === true;
  });
  return PermissionPrompt.of({ ask, confirmAppLink });
});

export const layer = Layer.effect(PermissionPrompt, make);
