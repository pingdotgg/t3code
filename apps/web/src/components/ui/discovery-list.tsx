import type { ComponentProps, ReactNode } from "react";

export function DiscoveryList({ children }: { readonly children: ReactNode }) {
  return (
    <div className="surface-card-settings border border-transparent flex flex-col divide-y divide-border/60 overflow-hidden rounded-card">
      {children}
    </div>
  );
}

export function DiscoveryListRow({
  icon,
  title,
  description,
  action,
  ...props
}: Omit<ComponentProps<"button">, "title" | "children" | "className"> & {
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <button
      type="button"
      {...props}
      className="group flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-accent focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-64"
    >
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label text-foreground">{title}</span>
        <span className="truncate text-meta text-muted-foreground">{description}</span>
      </div>
      {action}
    </button>
  );
}
