// Browser page translation (Chrome, Edge) swaps text nodes for <font> wrappers React does not
// know about, so a later removeChild or insertBefore on the original node throws NotFoundError
// and takes down the whole tree. See facebook/react#11538.
export function guardDomAgainstPageTranslation(): void {
  const proto = Node.prototype;
  const removeChild = proto.removeChild;
  const insertBefore = proto.insertBefore;

  proto.removeChild = function <T extends Node>(this: Node, child: T): T {
    // Already detached by the translator: nothing left to remove.
    if (child.parentNode !== this) return child;
    return removeChild.call(this, child) as T;
  };

  proto.insertBefore = function <T extends Node>(this: Node, node: T, reference: Node | null): T {
    // The anchor was replaced; append so the new node still shows.
    const anchor = reference && reference.parentNode !== this ? null : reference;
    return insertBefore.call(this, node, anchor) as T;
  };
}
