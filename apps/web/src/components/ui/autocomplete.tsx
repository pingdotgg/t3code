"use client";

import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";

const Autocomplete = AutocompletePrimitive.Root;

function AutocompleteItem({ className, children, ...props }: AutocompletePrimitive.Item.Props) {
  return (
    <AutocompletePrimitive.Item
      className={cn(
        "flex min-h-8 cursor-default select-none items-center rounded-sm px-2 py-1 text-base outline-none hover:bg-accent data-disabled:pointer-events-none data-selected:bg-accent/50 data-selected:text-foreground data-highlighted:bg-accent data-highlighted:text-accent-foreground [&[data-highlighted][data-selected]]:bg-accent [&[data-highlighted][data-selected]]:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm",
        className,
      )}
      data-slot="autocomplete-item"
      {...props}
    >
      {children}
    </AutocompletePrimitive.Item>
  );
}

function AutocompleteList({ className, ...props }: AutocompletePrimitive.List.Props) {
  return (
    <ScrollArea scrollbarGutter scrollFade>
      <AutocompletePrimitive.List
        className={cn("not-empty:scroll-py-1 not-empty:p-1 in-data-has-overflow-y:pe-3", className)}
        data-slot="autocomplete-list"
        {...props}
      />
    </ScrollArea>
  );
}

export { Autocomplete, AutocompleteItem, AutocompleteList };
