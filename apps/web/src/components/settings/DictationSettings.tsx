import { useState } from "react";
import type { DictationReplacement } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Switch } from "../ui/switch";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function DictationSettings() {
  const { scope, connectedEnvironments } = useSettingsScope();
  return (
    <DictationSettingsForm
      key={`${scope.kind}:${connectedEnvironments.map((environment) => environment.environmentId).join(":")}`}
    />
  );
}

function DictationSettingsForm() {
  const settings = useScopedSettings((value) => value.dictation);
  const update = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const enabled =
    (scope.kind === "environment" || scope.kind === "all") && connectedEnvironments.length === 1;
  const [editing, setEditing] = useState<DictationReplacement | null>(null);
  const [kind, setKind] = useState<DictationReplacement["kind"]>("word");
  const [phrase, setPhrase] = useState("");
  const [replacement, setReplacement] = useState("");
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setEditing(null);
    setPhrase("");
    setReplacement("");
    setError(null);
  };
  const save = () => {
    const trigger = phrase.trim();
    if (!trigger || !replacement.trim()) {
      setError("Enter both the spoken phrase and its replacement.");
      return;
    }
    if (
      settings.replacements.some(
        (entry) =>
          entry.phrase !== editing?.phrase && entry.phrase.toLowerCase() === trigger.toLowerCase(),
      )
    ) {
      setError("That spoken phrase already has a replacement.");
      return;
    }
    if (editing === null && settings.replacements.length >= 200) {
      setError("Remove an entry before adding another (200 maximum).");
      return;
    }
    const entry = { kind, phrase: trigger, replacement };
    if (
      editing !== null &&
      !settings.replacements.some(
        (item) =>
          item.phrase === editing.phrase &&
          item.kind === editing.kind &&
          item.replacement === editing.replacement,
      )
    ) {
      setError("This entry changed on another client. Cancel and open it again.");
      return;
    }
    update({
      dictation: {
        replacements:
          editing === null
            ? [...settings.replacements, entry]
            : settings.replacements.map((old) => (old.phrase === editing.phrase ? entry : old)),
      },
    });
    reset();
  };
  return (
    <SettingsSection id="dictation" title="Dictation">
      <p className="px-4 pb-3 text-sm text-muted-foreground">
        Codex dictation on web and desktop. Choose one environment to edit its preferences; they
        follow you on clients connected to it. AI polish is always optional.
      </p>
      <fieldset disabled={!enabled} className="disabled:opacity-50">
        <SettingsRow
          title="Polish after dictation"
          description="Clean up grammar and corrections after you stop. You can keep typing or send immediately. Also available in the microphone menu."
          control={
            <Switch
              aria-label="Polish after dictation"
              checked={settings.autoPolish}
              onCheckedChange={(checked) => update({ dictation: { autoPolish: checked } })}
            />
          }
        />
        <SettingsRow
          title="Spoken commands"
          description={
            "Say “new paragraph”, “new line”, “bullet point”, “number one” to format text. “Scratch that” undoes the last dictated sentence."
          }
          control={
            <Switch
              aria-label="Spoken commands"
              checked={settings.spokenCommands}
              onCheckedChange={(checked) => update({ dictation: { spokenCommands: checked } })}
            />
          }
        />
        <SettingsRow
          title="Remove hesitation sounds"
          description={
            "Remove “um” and “uh” as you speak. Words such as “like” and “actually” stay intact."
          }
          control={
            <Switch
              aria-label="Remove hesitation sounds"
              checked={settings.removeFillers}
              onCheckedChange={(checked) => update({ dictation: { removeFillers: checked } })}
            />
          }
        />
        <div className="space-y-3 px-4 py-3">
          <h3 className="text-sm font-medium">Custom words and snippets</h3>
          <p className="text-xs text-muted-foreground">
            Correct a commonly misheard name, or expand a phrase such as “my test checklist” into
            saved text. Matches use whole phrases; saved text is inserted exactly.
          </p>
          {settings.replacements.map((entry, index) => (
            <div
              key={`${entry.kind}:${entry.phrase}`}
              className="flex items-start gap-3 rounded-md border p-3 text-sm"
            >
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {entry.phrase}{" "}
                  <span className="text-xs text-muted-foreground">
                    {entry.kind === "word" ? "Word" : "Snippet"}
                  </span>
                </p>
                <p className="max-h-20 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
                  {entry.replacement}
                </p>
              </div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setEditing({ ...entry });
                  setKind(entry.kind);
                  setPhrase(entry.phrase);
                  setReplacement(entry.replacement);
                  setError(null);
                }}
              >
                Edit
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  update({
                    dictation: {
                      replacements: settings.replacements.filter((_, item) => item !== index),
                    },
                  });
                  reset();
                }}
              >
                Delete
              </Button>
            </div>
          ))}
          <div className="space-y-2 rounded-md border p-3">
            <Select
              value={kind}
              onValueChange={(value) => {
                if (value === "word" || value === "snippet") setKind(value);
              }}
            >
              <SelectTrigger aria-label="Replacement type">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="word">Custom word</SelectItem>
                <SelectItem value="snippet">Snippet</SelectItem>
              </SelectPopup>
            </Select>
            <Input
              aria-label="Spoken phrase"
              placeholder={
                kind === "word"
                  ? "What you say, e.g. whisper flow"
                  : "Spoken shortcut, e.g. my test checklist"
              }
              maxLength={100}
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
            <Textarea
              aria-label="Replacement text"
              placeholder={
                kind === "word" ? "Preferred spelling, e.g. Wispr Flow" : "Text to insert"
              }
              maxLength={4000}
              value={replacement}
              onChange={(event) => setReplacement(event.target.value)}
            />
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={save}>
                {editing === null ? "Add replacement" : "Save changes"}
              </Button>
              {editing !== null && (
                <Button size="sm" variant="ghost" onClick={reset}>
                  Cancel
                </Button>
              )}
            </div>
          </div>
        </div>
      </fieldset>
    </SettingsSection>
  );
}
