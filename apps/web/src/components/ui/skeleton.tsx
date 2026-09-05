import { cn } from "~/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-sm bg-muted-foreground/15 motion-safe:animate-skeleton", className)}
      data-slot="skeleton"
      {...props}
    />
  );
}

export { Skeleton };
