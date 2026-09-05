import { LoaderCircleIcon } from "lucide-react";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";

function Spinner({ className, ...props }: React.ComponentPropsWithoutRef<typeof LoaderCircleIcon>) {
  return (
    <LoaderCircleIcon
      aria-label="Loading"
      ref={observeVisibleAnimation}
      className={cn("motion-safe:visible-animate-spin", className)}
      role="status"
      {...props}
    />
  );
}

export { Spinner };
