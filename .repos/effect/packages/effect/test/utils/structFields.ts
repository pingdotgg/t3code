export function withIgnoredProperties<A extends object>(self: A): A {
  const get = () => {
    throw new Error("Non-enumerable and inherited fields must not be read")
  }
  Object.setPrototypeOf(
    self,
    Object.defineProperties(Object.create(Object.getPrototypeOf(self)), {
      inherited: { get, enumerable: true },
      [Symbol("inherited")]: { get, enumerable: true }
    })
  )
  return Object.defineProperties(self, {
    hidden: { get, enumerable: false },
    [Symbol("hidden")]: { get, enumerable: false }
  })
}
