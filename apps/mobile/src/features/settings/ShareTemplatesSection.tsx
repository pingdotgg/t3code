import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { TextInput, View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { uuidv4 } from "../../lib/uuid";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SHARE_TEMPLATE_PLACEHOLDER, type ShareTemplate } from "../sharing/share-templates";
import { SettingsSection } from "./components/SettingsSection";

export function ShareTemplatesSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [addedTemplateId, setAddedTemplateId] = useState<string | null>(null);
  const templates = AsyncResult.isSuccess(preferencesResult)
    ? (preferencesResult.value.shareTemplates ?? [])
    : null;

  const updateTemplates = (
    transform: (templates: ReadonlyArray<ShareTemplate>) => ReadonlyArray<ShareTemplate>,
  ) =>
    savePreferences({
      transform: (current) => ({ shareTemplates: transform(current.shareTemplates ?? []) }),
    });
  const addTemplate = () => {
    const id = uuidv4();
    setAddedTemplateId(id);
    updateTemplates((current) => [...current, { id, prompt: "" }]);
  };
  const removeTemplate = (template: ShareTemplate) => {
    const remove = () =>
      updateTemplates((current) => current.filter(({ id }) => id !== template.id));
    if (!template.prompt.trim()) {
      remove();
      return;
    }
    Dialog.confirm({
      title: "Delete this template?",
      confirmText: "Delete",
      destructive: true,
      onConfirm: remove,
    });
  };

  return (
    <SettingsSection
      title="Share templates"
      footer={`When you share to T3 Code from another app, choose a template to wrap what you shared. Write ${SHARE_TEMPLATE_PLACEHOLDER} where the shared text goes, or it goes at the end.`}
    >
      {(templates ?? []).map((template) => (
        <View
          key={template.id}
          className="flex-row items-start gap-1 border-b border-border-subtle py-1 pl-4"
        >
          {/* Uncontrolled so saving each keystroke never moves the cursor. */}
          <TextInput
            accessibilityLabel="Template prompt"
            className="min-h-12 flex-1 py-2 text-base text-foreground"
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={`Review this for bugs:\n\n${SHARE_TEMPLATE_PLACEHOLDER}`}
            multiline
            autoFocus={template.id === addedTemplateId}
            defaultValue={template.prompt}
            onChangeText={(prompt) =>
              updateTemplates((current) =>
                current.map((candidate) =>
                  candidate.id === template.id ? { ...candidate, prompt } : candidate,
                ),
              )
            }
          />
          <IconButton
            accessibilityLabel="Delete template"
            icon="trash"
            tintColorClassName="accent-danger-foreground"
            onPress={() => removeTemplate(template)}
          />
        </View>
      ))}
      <ListActionRow
        icon="plus"
        label="Add template"
        disabled={templates === null}
        onPress={addTemplate}
      />
    </SettingsSection>
  );
}
