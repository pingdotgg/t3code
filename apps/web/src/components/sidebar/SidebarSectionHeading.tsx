import { cn } from "~/lib/utils";

export function SidebarSectionHeading(props: {
  readonly as?: "div" | "li";
  readonly className?: string;
  readonly label: string;
}) {
  const Component = props.as ?? "li";
  return (
    <Component className={cn("mb-1 flex items-center gap-2", props.className)}>
      <span className="min-w-0 truncate text-xs font-medium text-sidebar-muted-foreground/80">
        {props.label}
      </span>
      <span className="h-px flex-1 bg-sidebar-border/60" />
    </Component>
  );
}
