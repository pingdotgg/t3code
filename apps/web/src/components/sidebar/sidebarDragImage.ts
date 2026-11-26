const STRIPPED_ATTRIBUTES = ["id", "data-sidebar-row", "data-sidebar-parent", "data-thread-item"];

/**
 * A see-through copy of a dragged row that follows the pointer, as the browser's
 * own drag image does for a dragged project folder. The copy takes no pointer
 * events and drops the tree attributes, so hit tests and keyboard navigation skip it.
 */
export function createSidebarDragImage(source: HTMLElement, point: { x: number; y: number }) {
  const rect = source.getBoundingClientRect();
  const image = source.cloneNode(true) as HTMLElement;
  for (const element of [image, ...image.querySelectorAll("*")]) {
    for (const name of STRIPPED_ATTRIBUTES) element.removeAttribute(name);
  }
  image.setAttribute("aria-hidden", "true");
  image.inert = true;
  Object.assign(image.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    opacity: "0.7",
    pointerEvents: "none",
    zIndex: "100",
  });
  const offset = { x: point.x - rect.left, y: point.y - rect.top };
  const move = (next: { x: number; y: number }) => {
    image.style.transform = `translate(${next.x - offset.x}px, ${next.y - offset.y}px)`;
  };
  move(point);
  document.body.append(image);
  return {
    move,
    setVisible: (visible: boolean) => {
      image.style.visibility = visible ? "visible" : "hidden";
    },
    remove: () => image.remove(),
  };
}

export type SidebarDragImage = ReturnType<typeof createSidebarDragImage>;
