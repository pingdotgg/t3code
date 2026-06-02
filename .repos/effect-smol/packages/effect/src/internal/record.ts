/**
 * @since 4.0.0
 */

/** @internal */
export function set<K extends PropertyKey, A>(self: Record<K, A>, key: K, value: A): Record<K, A> {
  if (key === "__proto__") {
    Object.defineProperty(self, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  } else {
    self[key] = value
  }
  return self
}
