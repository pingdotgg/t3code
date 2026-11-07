import type { PointerEvent } from "react";

/** A pointer-enter handler that titles the element with `title` only while it or a child is cut off. */
export function titleWhenClipped(title: string) {
  return (event: PointerEvent<HTMLElement>) => {
    const element = event.currentTarget;
    const clipped = [element, ...element.children].some(
      (node) => node.scrollWidth > node.clientWidth,
    );
    element.title = clipped ? title : "";
  };
}
