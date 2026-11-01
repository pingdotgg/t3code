import { useCommitOnBlur } from "~/hooks/useCommitOnBlur";
import { Input, type InputProps } from "./input";

export type DraftInputProps = Omit<InputProps, "value" | "onChange" | "defaultValue"> & {
  readonly value: string;
  readonly onCommit: (next: string) => void;
};

/** Commit drafts without settings-wide rerenders or server round trips per keystroke. */
export function DraftInput({ value, onCommit, ...rest }: DraftInputProps) {
  const bag = useCommitOnBlur(value, onCommit);
  return <Input {...rest} {...bag} />;
}
