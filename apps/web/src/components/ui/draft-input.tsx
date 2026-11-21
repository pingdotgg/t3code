import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Input, type InputProps } from "./input";
import { definePluginComponent } from "~/plugins/features";

export const DraftInput = definePluginComponent(
  "component:components/ui/draft-input/DraftInput",
  PluginOriginalDraftInput,
);

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
  readonly normalizeDraft?: (previous: string, next: string) => string;
};

/** Commit drafts without settings-wide rerenders or server round trips per keystroke. */
function PluginOriginalDraftInput({ value, onCommit, normalizeDraft, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit, normalizeDraft);
  return <Input {...rest} {...bag} />;
}
