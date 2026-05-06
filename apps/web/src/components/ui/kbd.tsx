import type * as React from "react";

import { cn } from "~/lib/utils";

function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "pointer-events-none inline-flex h-5 min-w-5 select-none items-center justify-center gap-1 rounded bg-muted px-1 font-medium font-sans text-muted-foreground text-xs [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      data-slot="kbd"
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      data-slot="kbd-group"
      {...props}
    />
  );
}

function Shortcut(props: React.ComponentProps<typeof Kbd>) {
  if (typeof props.children !== "string") {
    return <Kbd data-slot="shortcut" {...props} />;
  }

  const parts = splitShortcutLabel(props.children);
  if (parts.length <= 1) {
    return <Kbd data-slot="shortcut" {...props} />;
  }

  const { children: _children, className, ...kbdProps } = props;
  const classNames = className?.split(/\s+/).filter(Boolean) ?? [];
  const groupClassName = classNames.filter(isAutoMarginClassName).join(" ");
  const keyClassName = classNames.filter((name) => !isAutoMarginClassName(name)).join(" ");
  return (
    <KbdGroup aria-label={props.children} className={groupClassName}>
      {buildShortcutKeyParts(parts).map((part) => (
        <Kbd className={keyClassName} data-slot="shortcut" key={part.key} {...kbdProps}>
          {part.label}
        </Kbd>
      ))}
    </KbdGroup>
  );
}

function splitShortcutLabel(label: string): string[] {
  if (label.includes("+")) {
    const parts = label.split("+").filter(Boolean);
    return label.endsWith("+") ? [...parts, "+"] : parts;
  }

  if (label.includes(" ")) {
    return label.split(/\s+/).filter(Boolean);
  }

  const modifierParts = label.match(/^[⇧⌘⌥⌃]+/)?.[0] ?? "";
  if (!modifierParts) {
    return [label];
  }

  const key = label.slice(modifierParts.length);
  return [...modifierParts, ...(key ? [key] : [])];
}

function buildShortcutKeyParts(parts: readonly string[]): Array<{ key: string; label: string }> {
  const seenCounts = new Map<string, number>();
  const keyedParts: Array<{ key: string; label: string }> = [];
  for (const part of parts) {
    const seenCount = seenCounts.get(part) ?? 0;
    seenCounts.set(part, seenCount + 1);
    keyedParts.push({ key: `${part}:${seenCount}`, label: part });
  }
  return keyedParts;
}

function isAutoMarginClassName(className: string): boolean {
  return /^(m[eslrxy]?|[a-z]+:m[eslrxy]?)-auto$/.test(className);
}

export { Kbd, KbdGroup, Shortcut, splitShortcutLabel };
