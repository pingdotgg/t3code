"use client";

import type * as React from "react";
import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { cn } from "~/lib/utils";

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext() {
  const context = useContext(TabsContext);
  if (!context) {
    throw new Error("Tabs components must be rendered inside Tabs.");
  }
  return context;
}

function Tabs({
  className,
  value,
  defaultValue = "",
  onValueChange,
  ...props
}: React.ComponentProps<"div"> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
}) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue);
  const currentValue = value ?? uncontrolledValue;
  const handleValueChange = useCallback(
    (nextValue: string) => {
      if (value === undefined) {
        setUncontrolledValue(nextValue);
      }
      onValueChange?.(nextValue);
    },
    [onValueChange, value],
  );
  const context = useMemo<TabsContextValue>(
    () => ({ value: currentValue, onValueChange: handleValueChange }),
    [currentValue, handleValueChange],
  );

  return (
    <TabsContext.Provider value={context}>
      <div className={cn("flex flex-col gap-2", className)} data-slot="tabs" {...props} />
    </TabsContext.Provider>
  );
}

function TabsList({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "inline-flex h-7 shrink-0 items-center rounded-md bg-muted/70 p-0.5 text-muted-foreground",
        className,
      )}
      data-slot="tabs-list"
      role="tablist"
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  value,
  disabled,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "value"> & {
  value: string;
}) {
  const context = useTabsContext();
  const isActive = context.value === value;

  return (
    <button
      aria-selected={isActive}
      className={cn(
        "inline-flex h-6 min-w-10 cursor-pointer items-center justify-center rounded-[calc(var(--radius-md)-2px)] px-2 text-xs font-medium outline-none transition-[background-color,color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-xs/5",
        className,
      )}
      data-slot="tabs-trigger"
      data-state={isActive ? "active" : "inactive"}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          context.onValueChange(value);
        }
      }}
      role="tab"
      tabIndex={isActive ? 0 : -1}
      type="button"
      {...props}
    />
  );
}

function TabsContent({
  className,
  value,
  ...props
}: React.ComponentProps<"div"> & {
  value: string;
}) {
  const context = useTabsContext();
  if (context.value !== value) {
    return null;
  }

  return (
    <div
      className={cn("outline-none", className)}
      data-slot="tabs-content"
      role="tabpanel"
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
