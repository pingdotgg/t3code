/**
 * Lists own enumerable string and symbol keys without reading property values.
 * Use this when discovering struct fields; explicitly selected fields are read
 * independently of their enumerability.
 *
 * @internal
 */
export function ownEnumerableKeys(self: object): Array<string | symbol> {
  const keys: Array<string | symbol> = Object.keys(self)
  for (const key of Object.getOwnPropertySymbols(self)) {
    if (Object.prototype.propertyIsEnumerable.call(self, key)) {
      keys.push(key)
    }
  }
  return keys
}

/** @internal */
export function assignProperty(self: object, key: PropertyKey, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(self, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  } else {
    ;(self as any)[key] = value
  }
}

/** @internal */
export function assignProperties(self: object, source: object): void {
  // Object.assign would fire the inherited __proto__ setter for an own __proto__ key,
  // so use the safe per-property loop in that case.
  if (!Object.hasOwn(source, "__proto__")) {
    Object.assign(self, source)
    return
  }
  for (const key of ownEnumerableKeys(source)) {
    assignProperty(self, key, (source as any)[key])
  }
}
