import { isVscodeWebview } from "~/env";
import { cn } from "~/lib/utils";
import { SidebarTrigger, useSidebar } from "../ui/sidebar";

export function shouldRenderMainSidebarTrigger(input: {
  isMobile: boolean;
  open: boolean;
}): boolean {
  return input.isMobile || !input.open;
}

export function MainSidebarTrigger({ className }: { className?: string }) {
  const { isMobile, open } = useSidebar();

  if (!shouldRenderMainSidebarTrigger({ isMobile, open })) {
    return null;
  }

  return (
    <SidebarTrigger
      className={cn("size-7 shrink-0", isVscodeWebview ? "" : "md:hidden", className)}
    />
  );
}
