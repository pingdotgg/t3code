const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_FORWARD_REF_TYPE = Symbol.for("react.forward_ref");

export function isComponentType(value: unknown, depth = 0): boolean {
  if (typeof value === "function") return true;
  if (typeof value !== "object" || value === null || depth > 4) return false;
  const wrapper = value as { $$typeof?: unknown; type?: unknown; render?: unknown };
  if (wrapper.$$typeof === REACT_MEMO_TYPE) return isComponentType(wrapper.type, depth + 1);
  if (wrapper.$$typeof === REACT_FORWARD_REF_TYPE) return typeof wrapper.render === "function";
  return false;
}
