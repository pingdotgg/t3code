import * as React from "react";

import { cn } from "~/lib/utils";
import { definePluginComponent } from "~/plugins/features";

const Table = definePluginComponent("component:components/ui/table/Table", PluginOriginalTable);
const TableHeader = definePluginComponent(
  "component:components/ui/table/TableHeader",
  PluginOriginalTableHeader,
);
const TableBody = definePluginComponent(
  "component:components/ui/table/TableBody",
  PluginOriginalTableBody,
);
const TableRow = definePluginComponent(
  "component:components/ui/table/TableRow",
  PluginOriginalTableRow,
);
const TableHead = definePluginComponent(
  "component:components/ui/table/TableHead",
  PluginOriginalTableHead,
);
const TableCell = definePluginComponent(
  "component:components/ui/table/TableCell",
  PluginOriginalTableCell,
);

function PluginOriginalTable({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div data-slot="table-container" className="relative w-full overflow-x-auto">
      <table
        data-slot="table"
        className={cn("w-full caption-bottom text-xs", className)}
        {...props}
      />
    </div>
  );
}

function PluginOriginalTableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props} />;
}

function PluginOriginalTableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  );
}

function PluginOriginalTableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50 data-[state=selected]:bg-muted",
        className,
      )}
      {...props}
    />
  );
}

function PluginOriginalTableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

function PluginOriginalTableCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-cell"
      className={cn("p-2 align-middle whitespace-nowrap [&:has([role=checkbox])]:pr-0", className)}
      {...props}
    />
  );
}

export { Table, TableHeader, TableBody, TableHead, TableRow, TableCell };
