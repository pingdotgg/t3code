import { useGT } from "gt-react";
import { useRef, useState, type ReactNode } from "react";
import {
  ComposerPromptEditorTiptap as ComposerPromptEditor,
  type ComposerPromptEditorHandle,
} from "../ComposerPromptEditorTiptap";
import { useClientSettings } from "~/hooks/useSettings";
import { definePluginComponent } from "~/plugins/features";
import { ComposerSurface } from "./ComposerSurface";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import type { ComposerDraftContextRecords } from "../composerContextPresentation";
import { useAtomValue } from "@effect/atom-react";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { composerSubmissionIntentForKey } from "~/composer-logic";
import { useSoftwareKeyboardOpen } from "~/hooks/useSoftwareKeyboardOpen";

const noop = () => {};
const contextRecords: ComposerDraftContextRecords = new Map();
const skills: readonly never[] = [];

/** Controlled composer for plugin conversations; transport and history stay with the owner. */
export interface ConversationComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  pending?: boolean;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  controls?: ReactNode;
}

function BuiltinConversationComposer({
  value,
  onChange,
  onSubmit,
  onInterrupt,
  pending = false,
  busy = false,
  disabled = false,
  placeholder,
  ariaLabel,
  controls,
}: ConversationComposerProps) {
  const gt = useGT();
  const editorRef = useRef<ComposerPromptEditorHandle | null>(null);
  const [cursor, setCursor] = useState(value.length);
  const settings = useClientSettings();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const isSoftwareKeyboardOpen = useSoftwareKeyboardOpen();
  const hasText = Boolean(value.trim());
  const submit = () => {
    if (disabled || busy || pending || !hasText) return;
    onSubmit();
    editorRef.current?.focus();
  };
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <ComposerSurface.Body>
              <ComposerPromptEditor
                editorRef={editorRef}
                value={value}
                cursor={cursor}
                richTextEnabled={settings.composerRichTextEnabled}
                contextRecords={contextRecords}
                skills={skills}
                disabled={disabled}
                placeholder={placeholder ?? gt("Ask anything...")}
                ariaLabel={ariaLabel ?? gt("Message", { $context: "composer input label" })}
                onChange={(nextValue, nextCursor) => {
                  setCursor(nextCursor);
                  onChange(nextValue);
                }}
                onPaste={noop}
                onCommandKeyDown={(_key, event) => {
                  if (
                    composerSubmissionIntentForKey({
                      event,
                      keybindings,
                      context: {},
                      isSoftwareKeyboardOpen,
                      isDraftThread: false,
                      sendShortcut: settings.sendShortcut,
                      prompt: value,
                    }) === null
                  )
                    return false;
                  submit();
                  return true;
                }}
              />
            </ComposerSurface.Body>
            <ComposerSurface.Toolbar>
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">{controls}</div>
              <ComposerPrimaryActions
                compact
                canOperateThread={!disabled}
                pendingAction={null}
                isRunning={false}
                canInterrupt={pending}
                isSendBusy={busy}
                sendDisabledReason={
                  disabled
                    ? gt("Conversation unavailable")
                    : pending
                      ? gt("Wait for the answer or stop it")
                      : null
                }
                isEnvironmentUnavailable={false}
                isPreparingWorktree={false}
                hasSendableContent={pending ? false : hasText}
                preserveComposerFocusOnPointerDown
                onPreviousPendingQuestion={noop}
                onInterrupt={onInterrupt}
              />
            </ComposerSurface.Toolbar>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

export const ConversationComposer = definePluginComponent(
  "component:components/chat/ConversationComposer/ConversationComposer",
  BuiltinConversationComposer,
);
