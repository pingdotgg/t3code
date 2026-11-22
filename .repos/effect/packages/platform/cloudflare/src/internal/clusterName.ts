import type { ClusterName } from "../CloudflareCluster.ts"

/** @internal */
export const encodeName = (type: string, id: string): string => `${type.length}:${type}${id}`

const lengthPrefix = /^([1-9]\d*):/

/** @internal */
export const decodeName = (name: string): ClusterName | undefined => {
  const match = lengthPrefix.exec(name)
  if (match === null) return undefined
  const typeLength = Number(match[1])
  const payload = name.slice(match[0].length)
  if (typeLength > payload.length) return undefined
  return {
    type: payload.slice(0, typeLength),
    id: payload.slice(typeLength)
  }
}
