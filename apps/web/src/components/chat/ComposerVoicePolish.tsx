import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { polishVoice } from "@t3tools/client-runtime/voice-input";
import { ChevronDownIcon } from "lucide-react";
import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import {
  captureVoicePolish,
  resolveVoicePolishCommit,
  captureVoicePolishUndo,
} from "../../voice/voicePolish";
import type { ComposerVoiceDraft, ComposerVoiceCommit } from "../../voice/composerVoiceSession";
import { Button } from "../ui/button";
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuGroup,
  MenuGroupLabel,
} from "../ui/menu";
import { Textarea } from "../ui/textarea";

type Suggestion = { captured: ComposerVoiceDraft; text: string };

export function ComposerVoicePolish(props: {
  environmentId: EnvironmentId;
  instanceId: ProviderInstanceId;
  disabled: boolean;
  busy: boolean;
  completedDraft: ComposerVoiceDraft | null;
  readDraft: () => ComposerVoiceDraft | null;
  commitDraft: (commit: ComposerVoiceCommit) => boolean;
}) {
  const settings = useEnvironmentSettings(props.environmentId, (value) => value.dictation);
  const update = useUpdateEnvironmentSettings(props.environmentId);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Suggestion | null>(null);
  const [undo, setUndo] = useState<Suggestion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const aborter = useRef<AbortController | null>(null);
  const consumedCompletion = useRef<ComposerVoiceDraft | null>(null);
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  useEffect(
    () => () => {
      aborter.current?.abort();
    },
    [],
  );

  const dismiss = () => {
    aborter.current?.abort();
    aborter.current = null;
    setLoading(false);
    setResult(null);
    setUndo(null);
    setError(null);
  };
  const commitSuggestion = (suggestion: Suggestion) => {
    const current = latest.current;
    if (current.disabled || current.busy) return false;
    const commit = resolveVoicePolishCommit(
      suggestion.captured,
      current.readDraft(),
      suggestion.text,
    );
    if (!commit || !current.commitDraft(commit)) return false;
    setUndo(captureVoicePolishUndo(suggestion.captured, suggestion.text));
    setResult(null);
    setError(null);
    return true;
  };
  const start = async (draft: ComposerVoiceDraft) => {
    if (latest.current.disabled || latest.current.busy) return;
    dismiss();
    const prepared = readPreparedConnection(props.environmentId);
    if (!prepared) {
      setError("Reconnect to this environment to use AI polish.");
      return;
    }
    const captured = captureVoicePolish(draft);
    const text = captured.text.slice(captured.selectionStart, captured.selectionEnd);
    if (!text.trim()) {
      setError("Write or dictate some text first.");
      return;
    }
    if (text.length > 30_000) {
      setError("This draft is too long to polish (30,000 characters maximum).");
      return;
    }
    const request = new AbortController();
    aborter.current = request;
    setLoading(true);
    try {
      const response = await runtime.runPromise(
        polishVoice(prepared, props.instanceId, text, "cleanup"),
        { signal: request.signal },
      );
      if (request.signal.aborted) return;
      const suggestion = { captured, text: response.text };
      if (!commitSuggestion(suggestion)) {
        setResult(suggestion);
        setError(
          "Your draft changed, so polish was not applied. Copy any suggestion you want to keep.",
        );
      }
    } catch {
      if (!request.signal.aborted)
        setError(
          "Could not polish this text. Your draft is unchanged. Polish will try again after your next dictation.",
        );
    } finally {
      if (!request.signal.aborted) setLoading(false);
    }
  };

  const handleSessionChange = useEffectEvent(
    (
      completed: ComposerVoiceDraft | null,
      busy: boolean,
      disabled: boolean,
      autoPolish: boolean,
    ) => {
      // A new recording takes priority; turning polish off cancels a pending request.
      if (busy || disabled || !autoPolish) dismiss();
      if (consumedCompletion.current === completed) return;
      consumedCompletion.current = completed;
      if (autoPolish && completed && !busy && !disabled) void start(completed);
    },
  );
  useEffect(() => {
    handleSessionChange(props.completedDraft, props.busy, props.disabled, settings.autoPolish);
  }, [props.completedDraft, props.busy, props.disabled, settings.autoPolish]);

  const apply = () => {
    if (result && !commitSuggestion(result))
      setError(
        "Your draft changed. Copy any suggestion you want to keep, or dismiss and polish again.",
      );
  };
  const undoPolish = () => {
    if (!undo || props.disabled || props.busy) return;
    const commit = resolveVoicePolishCommit(undo.captured, props.readDraft(), undo.text);
    if (commit && props.commitDraft(commit)) dismiss();
    else
      setError(
        "Your draft changed after polishing. Undo is unavailable so your edits stay intact.",
      );
  };
  return (
    <div className="relative shrink-0">
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className={`gap-1 px-1.5 ${settings.autoPolish ? "text-primary" : "text-muted-foreground"}`}
              disabled={props.disabled}
              title={
                loading
                  ? "Polishing…"
                  : `Dictation options — AI polish ${settings.autoPolish ? "on" : "off"}`
              }
              aria-label={
                loading
                  ? "Dictation options, polishing"
                  : `Dictation options, AI polish ${settings.autoPolish ? "on" : "off"}`
              }
            />
          }
        >
          <span className="text-xs" role="status">
            {loading ? "Polishing…" : settings.autoPolish ? "Polish" : null}
          </span>
          <ChevronDownIcon className="size-3.5" />
        </MenuTrigger>
        <MenuPopup side="top" align="end" className="w-72">
          {loading && <MenuItem onClick={dismiss}>Cancel polish</MenuItem>}
          {undo && (
            <MenuItem disabled={props.busy} onClick={undoPolish}>
              Undo polish
            </MenuItem>
          )}
          {(loading || undo) && <MenuSeparator />}
          <MenuGroup>
            <MenuGroupLabel>After dictation</MenuGroupLabel>
            <MenuRadioGroup
              value={settings.autoPolish ? "on" : "off"}
              onValueChange={(value) =>
                update({ dictation: { ...settings, autoPolish: value === "on" } })
              }
            >
              <MenuRadioItem value="off">
                <span className="flex items-center gap-3">
                  <span className="flex-1">
                    <span className="block">Dictation only</span>
                    <span className="block text-xs text-muted-foreground">
                      Instant punctuation, no AI polish.
                    </span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
              <MenuRadioItem value="on">
                <span className="flex items-center gap-3">
                  <span className="flex-1">
                    <span className="block">Polish after dictation</span>
                    <span className="block text-xs text-muted-foreground">
                      Clean up the draft in the background.
                    </span>
                  </span>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      </Menu>
      {(result || error) && (
        <div
          className="absolute bottom-full right-0 z-30 mb-2 w-80 max-w-[calc(100vw-2rem)] space-y-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg"
          role="region"
          aria-label="AI polish"
        >
          <p className="text-sm font-medium">AI editing suggestion</p>
          {result && (
            <Textarea
              aria-label="Suggested text"
              readOnly
              value={result.text}
              className="max-h-64 min-h-32"
            />
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={dismiss}>
              Dismiss
            </Button>
            {result && (
              <Button
                type="button"
                size="sm"
                disabled={props.disabled || props.busy}
                onClick={apply}
              >
                Apply
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
