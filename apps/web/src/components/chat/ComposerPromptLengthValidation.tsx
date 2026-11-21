import { definePluginComponent } from "~/plugins/features";

export const ComposerPromptLengthValidation = definePluginComponent(
  "component:components/chat/ComposerPromptLengthValidation/ComposerPromptLengthValidation",
  PluginOriginalComposerPromptLengthValidation,
);
function PluginOriginalComposerPromptLengthValidation({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <p
      role="alert"
      className="px-3 pb-2 text-xs text-destructive sm:px-4"
      data-chat-composer-validation="prompt-length"
    >
      {message}
    </p>
  );
}
