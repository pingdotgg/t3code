import type { ReactNode } from "react";

import { Toggle, ToggleGroup } from "../ui/toggle-group";

interface DetailTab<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

export function DetailTabStrip<Value extends string>({
  label,
  tabs,
  active,
  onSelect,
  children,
}: {
  /** Names the strip for a reader who arrives on it without the panel around it. */
  label: string;
  tabs: ReadonlyArray<DetailTab<Value>>;
  active: Value;
  onSelect: (value: Value) => void;
  /** What the active tab hangs on the right: a count, a sort control, a check summary. */
  children?: ReactNode;
}) {
  return (
    <nav
      className="col-span-2 flex min-w-0 items-center gap-1 overflow-x-auto border-t border-border/60 px-4 py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label={label}
    >
      <ToggleGroup
        size="segmented"
        variant="segmented"
        value={[active]}
        onValueChange={(next) => {
          const value = tabs.find((item) => item.value === next[0])?.value;
          if (value) onSelect(value);
        }}
      >
        {tabs.map((item) => (
          <Toggle key={item.value} value={item.value}>
            {item.label}
          </Toggle>
        ))}
      </ToggleGroup>
      {children}
    </nav>
  );
}
