import { useGT } from "gt-react";

import { cn } from "~/lib/utils";

import { DraftInput, type DraftInputProps } from "../ui/draft-input";
import { Input, type InputProps } from "../ui/input";

type SecretInputProps = Omit<InputProps, "type" | "autoComplete" | "defaultValue" | "value"> & {
  /** Pass only the replacement draft as `value`. */
  readonly configured?: boolean;
  readonly value: string;
  readonly onCommit?: DraftInputProps["onCommit"];
};

export function SecretInput({
  configured = false,
  placeholder,
  onCommit,
  ...props
}: SecretInputProps) {
  const gt = useGT();
  // Masked with CSS instead of type="password", as t3chat does, so browsers and password managers
  // do not offer to save an API key as a site password. The placeholder stays readable.
  const shared = {
    ...props,
    type: "text" as const,
    autoComplete: "off",
    spellCheck: false,
    autoCapitalize: "off",
    autoCorrect: "off",
    "data-1p-ignore": true,
    "data-lpignore": "true",
    "data-bwignore": true,
    className: cn(
      "[&:has(input:not(:placeholder-shown))]:[-webkit-text-security:disc] [&:has(input:not(:placeholder-shown))]:[text-security:disc]",
      props.className,
    ),
    placeholder: configured
      ? gt("Stored secret, enter a new value to replace")
      : (placeholder ?? gt("Not set")),
  };
  if (onCommit) {
    return (
      <DraftInput
        {...shared}
        onCommit={(next) => {
          if (configured && next === "") return;
          onCommit(next);
        }}
      />
    );
  }
  return <Input {...shared} />;
}
