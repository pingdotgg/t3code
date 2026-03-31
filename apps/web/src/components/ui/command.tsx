"use client";

import type * as React from "react";
import { cn } from "~/lib/utils";
import { Autocomplete, AutocompleteItem, AutocompleteList } from "~/components/ui/autocomplete";

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      open
      {...props}
    />
  );
}
function CommandList({ className, ...props }: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={cn("not-empty:scroll-py-2 not-empty:p-2", className)}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) {
  return (
    <AutocompleteItem className={cn("py-1.5", className)} data-slot="command-item" {...props} />
  );
}

export { Command, CommandItem, CommandList };
