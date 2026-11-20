import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, View } from "react-native";
import type { IssueTransition } from "@t3tools/contracts";
import {
  issueTransitionSubmission,
  type IssueTransitionDrafts,
} from "@t3tools/client-runtime/issue-transitions";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Sheet } from "../../components/ui/Sheet";
import { SymbolView } from "../../components/ui/AppSymbol";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

export function IssueTransitionDialog(props: {
  readonly transition: IssueTransition;
  readonly issueKey: string;
  readonly issueUrl: string;
  readonly onClose: () => void;
  readonly onSubmit: (
    fields: ReturnType<typeof issueTransitionSubmission>["fields"],
  ) => Promise<string | null>;
}) {
  const gt = useGT();
  const validationMessages = {
    required: gt("This field is required."),
    "invalid-choice": gt("Choose a valid value."),
    "invalid-value": gt("Enter a value."),
    "invalid-number": gt("Enter a valid number."),
    "invalid-date": gt("Use YYYY-MM-DD."),
    "invalid-datetime": gt("Enter a valid date and time."),
  };
  const [drafts, setDrafts] = useState<IssueTransitionDrafts>({});
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submission = issueTransitionSubmission(props.transition, drafts);
  const setDraft = (id: string, value: string | ReadonlyArray<string>) =>
    setDrafts((held) => ({ ...held, [id]: value }));
  const submit = async () => {
    setAttempted(true);
    if (submission.blocked || Object.keys(submission.errors).length > 0 || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const error = await props.onSubmit(submission.fields);
    inFlight.current = false;
    setBusy(false);
    if (error === null) props.onClose();
    else setFailure(error);
  };
  return (
    <Sheet title={props.transition.name} onClose={props.onClose} dismissDisabled={busy}>
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <NativeScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 36 }}
        >
          <View className="gap-4">
            <Text className="text-sm text-foreground-muted">
              {props.issueKey} → {props.transition.to.name}
            </Text>
            {props.transition.fields.map((field) => {
              const draft = drafts[field.id];
              const value = typeof draft === "string" ? draft : "";
              const errorCode = attempted ? submission.errors[field.id] : undefined;
              const error = errorCode === undefined ? undefined : validationMessages[errorCode];
              return (
                <View key={field.id} className="gap-2">
                  <Text className="text-sm font-t3-medium">
                    {field.label}
                    {field.required ? " *" : ` (${gt("Optional")})`}
                  </Text>
                  {field.type === "unsupported" ? (
                    <Text className="text-sm text-foreground-muted">
                      {gt("This field needs Jira’s own editor.")}
                    </Text>
                  ) : field.type === "select" || field.type === "multiselect" ? (
                    <View className="gap-1 rounded-2xl bg-grouped-card p-2">
                      {field.options.map((option) => {
                        const selected =
                          field.type === "select"
                            ? value === option.value
                            : typeof draft !== "string" && draft?.includes(option.value) === true;
                        return (
                          <Pressable
                            key={option.value}
                            accessibilityRole={field.type === "select" ? "radio" : "checkbox"}
                            accessibilityLabel={`${field.label}, ${option.label}`}
                            accessibilityState={{ checked: selected, disabled: busy }}
                            disabled={busy}
                            onPress={() => {
                              if (field.type === "select")
                                setDraft(field.id, selected ? "" : option.value);
                              else {
                                const held = typeof draft === "string" ? [] : (draft ?? []);
                                setDraft(
                                  field.id,
                                  selected
                                    ? held.filter((v) => v !== option.value)
                                    : [...held, option.value],
                                );
                              }
                            }}
                            className="min-h-11 flex-row items-center justify-between gap-3 rounded-xl px-3 py-2 active:opacity-70"
                          >
                            <Text className="min-w-0 flex-1 text-sm">{option.label}</Text>
                            {selected ? (
                              <SymbolView
                                name="checkmark"
                                size={16}
                                tintColorClassName="accent-primary-text"
                              />
                            ) : null}
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : (
                    <TextInput
                      accessibilityLabel={field.label}
                      editable={!busy}
                      multiline={field.type === "multiline"}
                      value={value}
                      onChangeText={(text) => setDraft(field.id, text)}
                      placeholder={
                        field.type === "date"
                          ? "YYYY-MM-DD"
                          : field.type === "datetime"
                            ? "YYYY-MM-DDTHH:mm±HH:mm"
                            : undefined
                      }
                      placeholderTextColorClassName="accent-foreground-muted"
                      autoCapitalize="none"
                      keyboardType={field.type === "number" ? "numbers-and-punctuation" : "default"}
                      maxLength={65536}
                      className={
                        field.type === "multiline"
                          ? "min-h-32 rounded-2xl bg-grouped-card p-3 text-base text-foreground"
                          : "min-h-12 rounded-2xl bg-grouped-card px-3 text-base text-foreground"
                      }
                      style={field.type === "multiline" ? { textAlignVertical: "top" } : undefined}
                    />
                  )}
                  {error ? (
                    <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
                      {error}
                    </Text>
                  ) : null}
                </View>
              );
            })}
            {submission.blocked ? (
              <Text accessibilityRole="alert" className="text-sm text-foreground-muted">
                {gt("A required field needs Jira’s editor. Complete this transition in Jira.")}
              </Text>
            ) : null}
            {failure ? (
              <Text accessibilityRole="alert" selectable className="text-sm text-danger-foreground">
                {failure}
              </Text>
            ) : null}
            {submission.blocked ? null : (
              <Button
                fullWidth
                tone="contrast"
                label={busy ? gt("Applying…") : gt("Apply transition")}
                loading={busy}
                onPress={() => void submit()}
              />
            )}
            <Button
              fullWidth
              label={gt("Open in Jira")}
              icon="arrow.up.right"
              onPress={() => void Linking.openURL(props.issueUrl)}
            />
            <Button
              fullWidth
              tone="text"
              label={gt("Cancel")}
              disabled={busy}
              onPress={props.onClose}
            />
          </View>
        </NativeScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
