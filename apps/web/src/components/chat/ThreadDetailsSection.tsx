import type { ComponentProps, Ref } from "react";
import { MenuSeparator } from "../ui/menu";

/** Untitled groups use the same inset and hairline as a MenuPopup. */
export function ThreadDetailsSection({
  title,
  children,
  contentRef,
  ...props
}: Omit<ComponentProps<"section">, "className" | "style" | "title" | "aria-labelledby"> & {
  title: string;
  contentRef?: Ref<HTMLDivElement>;
}) {
  return (
    <section
      {...props}
      aria-label={title}
      className="px-1 first:pt-1 last:pb-1 has-[>div:last-child:empty]:hidden [&>[data-slot=menu-separator]]:hidden [section:not(:has(>div:last-child:empty))~&>[data-slot=menu-separator]]:block"
    >
      <MenuSeparator />
      <div ref={contentRef} className="flex flex-col">
        {children}
      </div>
    </section>
  );
}
