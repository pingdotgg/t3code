import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useRef } from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly panelSize?: "list" | "tall-list" | "fill";
  readonly showBackHint?: boolean;
  readonly testId?: string;
};

export function CommandPaletteContent({
  children,
  escapeLabel = "Close",
  footerActionLabel,
  footerTrailing,
  inputAccessory,
  inputProps,
  panelSize = "list",
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Direct-open flows replace the initial palette view after the dialog has
  // already moved focus. Reclaim it when the replacement input mounts so
  // typing cannot continue in the composer behind the modal. Defer until the
  // dialog has recorded the previous focus target for restoration on close.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput autoFocus={false} {...inputProps} ref={inputRef} />
          {inputAccessory}
        </div>
        <CommandPanel
          className={
            panelSize === "fill"
              ? "flex min-h-0 flex-1 flex-col"
              : panelSize === "tall-list"
                ? "max-h-[min(34rem,76vh)]"
                : "flex max-h-[min(28rem,70vh)] min-h-0 flex-col"
          }
        >
          {children}
        </CommandPanel>
        <CommandFooter className="max-sm:flex-col max-sm:items-start">
          <div className="flex items-center gap-3">
            <KbdGroup>
              <Kbd>
                <ArrowUpIcon />
              </Kbd>
              <Kbd>
                <ArrowDownIcon />
              </Kbd>
              <span>Navigate</span>
            </KbdGroup>
            {footerActionLabel !== undefined ? (
              <KbdGroup>
                <Kbd>Enter</Kbd>
                <span>{footerActionLabel}</span>
              </KbdGroup>
            ) : null}
            {showBackHint ? (
              <KbdGroup>
                <Kbd>Backspace</Kbd>
                <span>Back</span>
              </KbdGroup>
            ) : null}
            <KbdGroup>
              <Kbd>Esc</Kbd>
              <span>{escapeLabel}</span>
            </KbdGroup>
          </div>
          {footerTrailing}
        </CommandFooter>
      </Command>
    </div>
  );
}
