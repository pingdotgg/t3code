/**
 * The media type of a `content-type` header, lowercased and without its
 * parameters, such as `"application/json"` for
 * `"Application/JSON; charset=utf-8"`.
 *
 * @internal
 */
export function normalize(contentType: string): string {
  const normalized = contentType.toLowerCase().trim()
  const index = normalized.indexOf(";")
  return index === -1 ? normalized : normalized.slice(0, index).trim()
}
