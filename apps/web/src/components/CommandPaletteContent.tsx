import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, type RefObject, useLayoutEffect, useRef } from "react";

import { Command, CommandFooter, CommandInput, CommandPanel } from "./ui/command";
import { Kbd, KbdGroup } from "./ui/kbd";

function claimFocusInOpenDialog(input: HTMLInputElement | null) {
  if (!input) return;
  const active = input.ownerDocument.activeElement;
  if (active === input) return;
  if (
    active === null ||
    active === input.ownerDocument.body ||
    input.closest('[role="dialog"]')?.contains(active)
  ) {
    input.focus();
  }
}

export interface PendingInputSelection {
  readonly value: string;
  readonly start: number | null;
  readonly end: number | null;
  readonly direction: "forward" | "backward" | "none" | null;
}

function restorePendingSelection(
  input: HTMLInputElement,
  pendingSelectionRef: RefObject<PendingInputSelection | null> | undefined,
) {
  const selection = pendingSelectionRef?.current;
  if (!pendingSelectionRef || !selection) return;
  pendingSelectionRef.current = null;
  if (input.value !== selection.value) return;
  input.setSelectionRange(selection.start, selection.end, selection.direction ?? undefined);
}

type CommandPaletteContentProps = Omit<ComponentProps<typeof Command>, "children"> & {
  readonly children: ReactNode;
  readonly escapeLabel?: ReactNode;
  readonly footerActionLabel?: ReactNode;
  readonly footerTrailing?: ReactNode;
  readonly inputAccessory?: ReactNode;
  readonly inputProps: ComponentProps<typeof CommandInput>;
  readonly pendingSelectionRef?: RefObject<PendingInputSelection | null>;
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
  pendingSelectionRef,
  panelSize = "list",
  showBackHint,
  testId,
  ...commandProps
}: CommandPaletteContentProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Claim replacement input focus after child measurements, before the dialog restores focus.
  useLayoutEffect(() => {
    claimFocusInOpenDialog(inputRef.current);
  }, []);
  return (
    <div className="contents" data-testid={testId}>
      <Command {...commandProps}>
        <div className="relative">
          <CommandInput
            autoFocus={false}
            {...inputProps}
            ref={(input) => {
              inputRef.current = input;
              if (input) restorePendingSelection(input, pendingSelectionRef);
            }}
          />
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
