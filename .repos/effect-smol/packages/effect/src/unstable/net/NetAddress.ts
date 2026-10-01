/**
 * Pure, platform-neutral values for MAC, IP, internet socket, and Unix path addresses.
 *
 * @since 4.0.0
 */
import * as Data from "../../Data.ts"
import * as Equal from "../../Equal.ts"
import { dual } from "../../Function.ts"
import * as Hash from "../../Hash.ts"
import { NodeInspectSymbol } from "../../Inspectable.ts"
import * as Option from "../../Option.ts"
import { hasProperty } from "../../Predicate.ts"
import * as Result from "../../Result.ts"

const TypeId = "~effect/net/NetAddress" as const

/**
 * An immutable 32-bit IPv4 address.
 *
 * @category models
 * @since 4.0.0
 */
export interface Ipv4Address extends Equal.Equal, Hash.Hash {
  readonly _tag: "Ipv4Address"
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

/**
 * An immutable 128-bit IPv6 address without socket scope metadata.
 *
 * @category models
 * @since 4.0.0
 */
export interface Ipv6Address extends Equal.Equal, Hash.Hash {
  readonly _tag: "Ipv6Address"
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

/**
 * A numeric IPv4 or IPv6 address.
 *
 * @category models
 * @since 4.0.0
 */
export type IpAddress = Ipv4Address | Ipv6Address

/**
 * An immutable 48-bit IEEE 802 MAC address.
 *
 * @category models
 * @since 4.0.0
 */
export interface MacAddress extends Equal.Equal, Hash.Hash {
  readonly _tag: "MacAddress"
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

const getBytes = (self: IpAddress | MacAddress): Uint8Array => (self as any).bytes

/**
 * A resolved IPv4 internet address and port.
 *
 * @category models
 * @since 4.0.0
 */
export interface InetAddressV4 extends Equal.Equal, Hash.Hash {
  readonly _tag: "InetAddressV4"
  readonly address: Ipv4Address
  readonly port: number
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

/**
 * A resolved IPv6 internet address, port, and scope identifier.
 *
 * @category models
 * @since 4.0.0
 */
export interface InetAddressV6 extends Equal.Equal, Hash.Hash {
  readonly _tag: "InetAddressV6"
  readonly address: Ipv6Address
  readonly port: number
  readonly scopeId: number
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

/**
 * A resolved IPv4 or IPv6 internet address and port.
 *
 * @category models
 * @since 4.0.0
 */
export type InetAddress = InetAddressV4 | InetAddressV6

/**
 * An opaque Unix-domain filesystem socket path.
 *
 * @category models
 * @since 4.0.0
 */
export interface UnixPathAddress extends Equal.Equal, Hash.Hash {
  readonly _tag: "UnixPathAddress"
  readonly path: string
  readonly [TypeId]: typeof TypeId
  toString(): string
  toJSON(): string
}

/**
 * A portable concrete internet or Unix-domain filesystem address.
 *
 * @category models
 * @since 4.0.0
 */
export type SocketAddress = InetAddress | UnixPathAddress

/**
 * Companion types for constructing socket addresses.
 *
 * @since 4.0.0
 */
export declare namespace SocketAddress {
  /**
   * Input that can be converted to a concrete `SocketAddress` without hostname
   * resolution.
   *
   * **Details**
   *
   * String inputs must use `IPv4:port` or `[IPv6]:port` notation. Address
   * properties must be numeric IPv4 or IPv6 literals.
   *
   * @category models
   * @since 4.0.0
   */
  export type Input =
    | SocketAddress
    | string
    | { readonly address: IpAddress | string; readonly port: number }
    | { readonly path: string }
}

/**
 * A checked network-address operation failure retaining the address or supplied input.
 *
 * **Details**
 *
 * Address-based operations retain the address value. Parsing and numeric
 * construction retain the supplied string or array. Composed operations forward
 * errors from the failing operation unchanged. Failures from external operations
 * retain the original exception in `cause` when available.
 *
 * @category errors
 * @since 4.0.0
 */
export class NetAddressError extends Data.TaggedError("NetAddressError")<{
  readonly message: string
  readonly input: unknown
  readonly cause?: unknown
}> {}

const isAddress = (u: unknown): u is IpAddress | MacAddress | SocketAddress => hasProperty(u, TypeId)

/**
 * Returns `true` when a value is an IPv4 address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isIpv4Address = (u: unknown): u is Ipv4Address => isAddress(u) && u._tag === "Ipv4Address"

/**
 * Returns `true` when a value is an IPv6 address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isIpv6Address = (u: unknown): u is Ipv6Address => isAddress(u) && u._tag === "Ipv6Address"

/**
 * Returns `true` when a value is an IPv4 or IPv6 address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isIpAddress = (u: unknown): u is IpAddress => isIpv4Address(u) || isIpv6Address(u)

/**
 * Returns the bit width of an IP address.
 *
 * @category getters
 * @since 4.0.0
 */
export const width = (address: IpAddress): 32 | 128 => isIpv4Address(address) ? 32 : 128

/**
 * Returns `true` when a value is a MAC address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isMacAddress = (u: unknown): u is MacAddress => isAddress(u) && u._tag === "MacAddress"

/**
 * Returns `true` when a value is a resolved IPv4 internet address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isInetAddressV4 = (u: unknown): u is InetAddressV4 => isAddress(u) && u._tag === "InetAddressV4"

/**
 * Returns `true` when a value is a resolved IPv6 internet address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isInetAddressV6 = (u: unknown): u is InetAddressV6 => isAddress(u) && u._tag === "InetAddressV6"

/**
 * Returns `true` when a value is a resolved internet address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isInetAddress = (u: unknown): u is InetAddress => isInetAddressV4(u) || isInetAddressV6(u)

/**
 * Returns `true` when a value is a Unix-domain filesystem address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isUnixPathAddress = (u: unknown): u is UnixPathAddress => isAddress(u) && u._tag === "UnixPathAddress"

/**
 * Returns `true` when a value is a portable concrete socket address.
 *
 * @category guards
 * @since 4.0.0
 */
export const isSocketAddress = (u: unknown): u is SocketAddress => isInetAddress(u) || isUnixPathAddress(u)

const Ipv4Proto = {
  _tag: "Ipv4Address",
  [TypeId]: TypeId,
  [Equal.symbol](this: Ipv4Address, that: Equal.Equal): boolean {
    return isIpv4Address(that) && bytesEqual(getBytes(this), getBytes(that))
  },
  [Hash.symbol](this: Ipv4Address): number {
    return hashBytes("Ipv4Address", getBytes(this))
  },
  toString(this: Ipv4Address): string {
    return formatIp(this)
  },
  toJSON(this: Ipv4Address): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: Ipv4Address): string {
    return this.toJSON()
  }
}

const Ipv6Proto = {
  _tag: "Ipv6Address",
  [TypeId]: TypeId,
  [Equal.symbol](this: Ipv6Address, that: Equal.Equal): boolean {
    return isIpv6Address(that) && bytesEqual(getBytes(this), getBytes(that))
  },
  [Hash.symbol](this: Ipv6Address): number {
    return hashBytes("Ipv6Address", getBytes(this))
  },
  toString(this: Ipv6Address): string {
    return formatIp(this)
  },
  toJSON(this: Ipv6Address): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: Ipv6Address): string {
    return this.toJSON()
  }
}

const MacProto = {
  _tag: "MacAddress",
  [TypeId]: TypeId,
  [Equal.symbol](this: MacAddress, that: Equal.Equal): boolean {
    return isMacAddress(that) && bytesEqual(getBytes(this), getBytes(that))
  },
  [Hash.symbol](this: MacAddress): number {
    return hashBytes("MacAddress", getBytes(this))
  },
  toString(this: MacAddress): string {
    return formatMacAddress(this)
  },
  toJSON(this: MacAddress): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: MacAddress): string {
    return this.toJSON()
  }
}

const bytesEqual = (self: Uint8Array, that: Uint8Array): boolean => {
  if (self.length !== that.length) return false
  for (let index = 0; index < self.length; index++) {
    if (self[index] !== that[index]) return false
  }
  return true
}

const hashBytes = (tag: string, bytes: Uint8Array): number => {
  return Hash.combine(Hash.string(tag), Hash.array(bytes))
}

const makeIpv4 = (bytes: Uint8Array): Ipv4Address => {
  const self = Object.assign(Object.create(Ipv4Proto), { bytes: new Uint8Array(bytes) })
  return Object.freeze(self)
}

const makeIpv6 = (bytes: Uint8Array): Ipv6Address => {
  const self = Object.assign(Object.create(Ipv6Proto), { bytes: new Uint8Array(bytes) })
  return Object.freeze(self)
}

const makeMac = (bytes: Uint8Array): MacAddress => {
  const self = Object.assign(Object.create(MacProto), { bytes: new Uint8Array(bytes) })
  return Object.freeze(self)
}

/**
 * Creates an IPv4 address from trusted network-order bytes without validation.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const ipv4FromBytesUnsafe = (bytes: Uint8Array): Ipv4Address => makeIpv4(bytes)

/**
 * Creates an IPv6 address from trusted network-order bytes without validation.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const ipv6FromBytesUnsafe = (bytes: Uint8Array): Ipv6Address => makeIpv6(bytes)

/**
 * The IPv4 loopback address `127.0.0.1`.
 *
 * @category constants
 * @since 4.0.0
 */
export const ipv4Loopback: Ipv4Address = makeIpv4(new Uint8Array([127, 0, 0, 1]))

/**
 * The IPv6 loopback address `::1`.
 *
 * @category constants
 * @since 4.0.0
 */
export const ipv6Loopback: Ipv6Address = makeIpv6(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]))

/**
 * The unspecified IPv4 address `0.0.0.0`.
 *
 * @category constants
 * @since 4.0.0
 */
export const ipv4Unspecified: Ipv4Address = makeIpv4(new Uint8Array(4))

/**
 * The unspecified IPv6 address `::`.
 *
 * @category constants
 * @since 4.0.0
 */
export const ipv6Unspecified: Ipv6Address = makeIpv6(new Uint8Array(16))

/**
 * The IPv4 broadcast address `255.255.255.255`.
 *
 * @category constants
 * @since 4.0.0
 */
export const ipv4Broadcast: Ipv4Address = makeIpv4(new Uint8Array([255, 255, 255, 255]))

const addressError = (input: unknown, message: string): Result.Result<never, NetAddressError> =>
  Result.fail(new NetAddressError({ input, message }))

/**
 * Creates an IPv4 address from four checked octets.
 *
 * @category constructors
 * @since 4.0.0
 */
export const ipv4FromOctets = (
  octets: readonly [number, number, number, number]
): Result.Result<Ipv4Address, NetAddressError> => {
  if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return addressError(octets, "octets must be integers from 0 through 255")
  }
  return Result.succeed(makeIpv4(new Uint8Array(octets)))
}

/**
 * Creates an IPv6 address from eight checked 16-bit segments.
 *
 * @category constructors
 * @since 4.0.0
 */
export const ipv6FromSegments = (
  segments: readonly [number, number, number, number, number, number, number, number]
): Result.Result<Ipv6Address, NetAddressError> => {
  if (!segments.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)) {
    return addressError(segments, "segments must be integers from 0 through 65535")
  }
  const bytes = new Uint8Array(16)
  for (let index = 0; index < 8; index++) {
    bytes[index * 2] = segments[index] >> 8
    bytes[index * 2 + 1] = segments[index]
  }
  return Result.succeed(makeIpv6(bytes))
}

/**
 * Creates a MAC address from six checked octets.
 *
 * @category constructors
 * @since 4.0.0
 */
export const macAddressFromOctets = (
  octets: readonly [number, number, number, number, number, number]
): Result.Result<MacAddress, NetAddressError> => {
  if (!octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    return addressError(octets, "octets must be integers from 0 through 255")
  }
  return Result.succeed(makeMac(new Uint8Array(octets)))
}

/**
 * Parses a colon-separated MAC address containing six two-digit hexadecimal octets.
 *
 * @category decoding
 * @since 4.0.0
 */
export const macAddressFromString = (input: string): Result.Result<MacAddress, NetAddressError> => {
  if (!/^(?:[0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(input)) {
    return addressError(input, "expected six two-digit hexadecimal octets separated by colons")
  }
  return Result.succeed(makeMac(new Uint8Array(input.split(":").map((part) => Number.parseInt(part, 16)))))
}

/**
 * Parses a trusted colon-separated MAC address, throwing on failure.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const macAddressFromStringUnsafe = (input: string): MacAddress => Result.getOrThrow(macAddressFromString(input))

/**
 * Parses a strict dotted-decimal IPv4 address.
 *
 * **Details**
 *
 * Multi-digit octets with a leading zero are rejected to avoid octal ambiguity.
 *
 * @category decoding
 * @since 4.0.0
 */
export const ipv4FromString = (input: string): Result.Result<Ipv4Address, NetAddressError> => {
  const parts = input.split(".")
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return addressError(input, "expected exactly four decimal octets")
  }
  if (parts.some((part) => part.length > 1 && part[0] === "0")) {
    return addressError(input, "leading zeroes are not allowed")
  }
  const octets = parts.map(Number)
  if (octets.some((part) => part > 255)) {
    return addressError(input, "octets must be at most 255")
  }
  return ipv4FromOctets([octets[0], octets[1], octets[2], octets[3]])
}

const parseIpv6Segments = (input: string): Result.Result<ReadonlyArray<number>, NetAddressError> => {
  if (input.includes("[") || input.includes("]") || input.includes("%")) {
    return addressError(input, "brackets and zone identifiers are not valid in a bare IPv6 address")
  }
  const halves = input.split("::")
  if (halves.length > 2) return addressError(input, "only one compression marker is allowed")
  const head = halves[0] === "" ? [] : halves[0].split(":")
  const tail = halves.length === 2 && halves[1] !== "" ? halves[1].split(":") : []
  if (head.some((part) => part === "") || tail.some((part) => part === "")) {
    return addressError(input, "empty segments are only valid in the compression marker")
  }
  const trailing = tail.length > 0 ? tail[tail.length - 1] : head.length > 0 ? head[head.length - 1] : ""
  let embedded: ReadonlyArray<number> | undefined
  if (trailing.includes(".")) {
    if (halves.length === 2 && tail.length === 0) {
      return addressError(input, "embedded IPv4 syntax must be trailing")
    }
    const parsed = Result.map(ipv4FromString(trailing), (address) => {
      const octets = ipv4ToOctets(address)
      return [octets[0] * 256 + octets[1], octets[2] * 256 + octets[3]]
    })
    if (Result.isFailure(parsed)) return parsed
    embedded = parsed.success
    if (tail.length > 0) tail.pop()
    else head.pop()
  }
  const explicit = head.length + tail.length + (embedded ? 2 : 0)
  if (halves.length === 1 ? explicit !== 8 : explicit >= 8) {
    return addressError(
      input,
      halves.length === 1 ? "expected eight segments" : "compression must replace at least one segment"
    )
  }
  const parse = (part: string): number | undefined =>
    /^[0-9a-fA-F]{1,4}$/.test(part) ? Number.parseInt(part, 16) : undefined
  const parsedHead = head.map(parse)
  const parsedTail = tail.map(parse)
  if (parsedHead.some((part) => part === undefined) || parsedTail.some((part) => part === undefined)) {
    return addressError(input, "segments must contain one through four hexadecimal digits")
  }
  return Result.succeed([
    ...parsedHead as ReadonlyArray<number>,
    ...Array(8 - explicit).fill(0),
    ...parsedTail as ReadonlyArray<number>,
    ...(embedded ?? [])
  ])
}

/**
 * Parses an IPv6 address with optional compression and trailing embedded IPv4.
 *
 * @category decoding
 * @since 4.0.0
 */
export const ipv6FromString = (input: string): Result.Result<Ipv6Address, NetAddressError> => {
  return Result.flatMap(
    parseIpv6Segments(input),
    (segments) =>
      ipv6FromSegments(
        segments as unknown as readonly [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number
        ]
      )
  )
}

/**
 * Parses a bare numeric IPv4 or IPv6 address.
 *
 * @category decoding
 * @since 4.0.0
 */
export const ipFromString = (input: string): Result.Result<IpAddress, NetAddressError> => {
  const result: Result.Result<IpAddress, NetAddressError> = input.includes(":")
    ? ipv6FromString(input)
    : ipv4FromString(input)
  return result
}

/**
 * Parses a trusted bare numeric IPv4 or IPv6 address, throwing on failure.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const ipFromStringUnsafe = (input: string): IpAddress => Result.getOrThrow(ipFromString(input))

/**
 * Returns the four numeric octets of an IPv4 address in a fresh tuple.
 *
 * @category getters
 * @since 4.0.0
 */
export const ipv4ToOctets = (self: Ipv4Address): readonly [number, number, number, number] => {
  const bytes = getBytes(self)
  return [bytes[0], bytes[1], bytes[2], bytes[3]]
}

/**
 * Returns the eight numeric segments of an IPv6 address in a fresh tuple.
 *
 * @category getters
 * @since 4.0.0
 */
export const ipv6ToSegments = (
  self: Ipv6Address
): readonly [number, number, number, number, number, number, number, number] => {
  const bytes = getBytes(self)
  const output = Array<number>(8)
  for (let index = 0; index < 8; index++) {
    output[index] = bytes[index * 2] * 256 + bytes[index * 2 + 1]
  }
  return output as any
}

/**
 * Returns the sixteen numeric octets of an IPv6 address in a fresh array.
 *
 * @category getters
 * @since 4.0.0
 */
export const ipv6ToOctets = (
  self: Ipv6Address
): ReadonlyArray<number> => Array.from(getBytes(self))

/**
 * Returns the six numeric octets of a MAC address in a fresh tuple.
 *
 * @category getters
 * @since 4.0.0
 */
export const macAddressToOctets = (
  self: MacAddress
): readonly [number, number, number, number, number, number] => {
  const bytes = getBytes(self)
  return [bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]]
}

/**
 * Formats a MAC address as six lowercase hexadecimal octets separated by colons.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatMacAddress = (self: MacAddress): string =>
  Array.from(getBytes(self), (byte) => byte.toString(16).padStart(2, "0")).join(":")

/**
 * Returns `true` when the MAC address is the all-ones broadcast address.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMacBroadcast = (self: MacAddress): boolean => getBytes(self).every((byte) => byte === 0xff)

/**
 * Returns `true` when the MAC address has the IEEE group-address bit set.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMacMulticast = (self: MacAddress): boolean => (getBytes(self)[0] & 1) !== 0

/**
 * Returns `true` when the MAC address has the IEEE group-address bit clear.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMacUnicast = (self: MacAddress): boolean => (getBytes(self)[0] & 1) === 0

/**
 * Returns `true` when the MAC address has the IEEE local-administration bit set.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMacLocallyAdministered = (self: MacAddress): boolean => (getBytes(self)[0] & 2) !== 0

/**
 * Returns `true` when the MAC address has the IEEE local-administration bit clear.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMacUniversallyAdministered = (self: MacAddress): boolean => (getBytes(self)[0] & 2) === 0

/**
 * Folds an IP address by its numeric version.
 *
 * @category pattern matching
 * @since 4.0.0
 */
export const match: {
  <A, B>(options: {
    readonly onIpv4: (address: Ipv4Address) => A
    readonly onIpv6: (address: Ipv6Address) => B
  }): (self: IpAddress) => A | B
  <A, B>(self: IpAddress, options: {
    readonly onIpv4: (address: Ipv4Address) => A
    readonly onIpv6: (address: Ipv6Address) => B
  }): A | B
} = dual(2, <A, B>(self: IpAddress, options: {
  readonly onIpv4: (address: Ipv4Address) => A
  readonly onIpv6: (address: Ipv6Address) => B
}): A | B => isIpv4Address(self) ? options.onIpv4(self) : options.onIpv6(self))

/**
 * Formats an IP address in canonical numeric form.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatIp = (self: IpAddress): string => {
  if (isIpv4Address(self)) return ipv4ToOctets(self).join(".")
  const segments = ipv6ToSegments(self)
  if (isIpv4Mapped(self)) {
    return `::ffff:${segments[6] >> 8}.${segments[6] & 0xff}.${segments[7] >> 8}.${segments[7] & 0xff}`
  }
  let bestStart = -1
  let bestLength = 0
  let start = -1
  for (let index = 0; index <= 8; index++) {
    if (index < 8 && segments[index] === 0) {
      if (start === -1) start = index
    } else if (start !== -1) {
      if (index - start > bestLength) {
        bestStart = start
        bestLength = index - start
      }
      start = -1
    }
  }
  if (bestLength < 2) return segments.map((segment) => segment.toString(16)).join(":")
  const head = segments.slice(0, bestStart).map((segment) => segment.toString(16)).join(":")
  const tail = segments.slice(bestStart + bestLength).map((segment) => segment.toString(16)).join(":")
  return `${head}::${tail}`
}

/**
 * Returns `true` for the all-zero address of either IP version.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isUnspecified = (self: IpAddress): boolean => getBytes(self).every((byte) => byte === 0)

/**
 * Returns `true` for IPv4 `127.0.0.0/8` or IPv6 `::1`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLoopback = (self: IpAddress): boolean => {
  if (isIpv4Address(self)) return getBytes(self)[0] === 127
  const bytes = getBytes(self)
  for (let index = 0; index < 15; index++) {
    if (bytes[index] !== 0) return false
  }
  return bytes[15] === 1
}

/**
 * Returns `true` for IPv4 `224.0.0.0/4` or IPv6 `ff00::/8`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isMulticast = (self: IpAddress): boolean => {
  if (isIpv4Address(self)) return (getBytes(self)[0] >> 4) === 0xe
  return getBytes(self)[0] === 0xff
}

/**
 * Returns `true` for the IPv4 broadcast address `255.255.255.255`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isBroadcast = (self: Ipv4Address): boolean => getBytes(self).every((byte) => byte === 0xff)

/**
 * Returns `true` for IPv4 `169.254.0.0/16` or IPv6 `fe80::/10`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isLinkLocal = (self: IpAddress): boolean => {
  if (isIpv4Address(self)) {
    const bytes = getBytes(self)
    return bytes[0] === 0xa9 && bytes[1] === 0xfe
  }
  const bytes = getBytes(self)
  return bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80
}

/**
 * Returns `true` for IPv4 private-use ranges defined by RFC 1918.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isPrivate = (self: Ipv4Address): boolean => {
  const bytes = getBytes(self)
  return bytes[0] === 10 || (bytes[0] === 172 && (bytes[1] & 0xf0) === 16) ||
    (bytes[0] === 192 && bytes[1] === 168)
}

/**
 * Returns `true` for IPv6 unique-local addresses in `fc00::/7`.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isUniqueLocal = (self: Ipv6Address): boolean => (getBytes(self)[0] & 0xfe) === 0xfc

/**
 * Returns `true` when an IPv6 address is in the `::ffff:0:0/96` mapped range.
 *
 * @category predicates
 * @since 4.0.0
 */
export const isIpv4Mapped = (self: Ipv6Address): boolean => {
  const bytes = getBytes(self)
  for (let index = 0; index < 10; index++) {
    if (bytes[index] !== 0) return false
  }
  return bytes[10] === 0xff && bytes[11] === 0xff
}

/**
 * Converts an IPv4 address to its IPv4-mapped IPv6 representation.
 *
 * @category converting
 * @since 4.0.0
 */
export const toIpv4Mapped = (self: Ipv4Address): Ipv6Address => {
  const bytes = new Uint8Array(16)
  bytes[10] = 0xff
  bytes[11] = 0xff
  bytes.set(getBytes(self), 12)
  return makeIpv6(bytes)
}

/**
 * Extracts the IPv4 value from an IPv4-mapped IPv6 address.
 *
 * @category converting
 * @since 4.0.0
 */
export const fromIpv4Mapped = (self: Ipv6Address): Option.Option<Ipv4Address> =>
  isIpv4Mapped(self) ? Option.some(makeIpv4(getBytes(self).slice(12))) : Option.none()

/**
 * Converts an IPv4-mapped IPv6 address to IPv4, leaving all other addresses unchanged.
 *
 * @category converting
 * @since 4.0.0
 */
export const toCanonical = (self: IpAddress): IpAddress =>
  isIpv6Address(self) ? Option.getOrElse(fromIpv4Mapped(self), () => self) : self

const InetV4Proto = {
  _tag: "InetAddressV4",
  [TypeId]: TypeId,
  [Equal.symbol](this: InetAddressV4, that: Equal.Equal): boolean {
    return isInetAddressV4(that) && this.port === that.port && Equal.equals(this.address, that.address)
  },
  [Hash.symbol](this: InetAddressV4): number {
    return Hash.combine(Hash.hash(this.address), Hash.number(this.port))
  },
  toString(this: InetAddressV4): string {
    return formatInet(this)
  },
  toJSON(this: InetAddressV4): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: InetAddressV4): string {
    return this.toJSON()
  }
}

const InetV6Proto = {
  _tag: "InetAddressV6",
  [TypeId]: TypeId,
  [Equal.symbol](this: InetAddressV6, that: Equal.Equal): boolean {
    return isInetAddressV6(that) && this.port === that.port && this.scopeId === that.scopeId &&
      Equal.equals(this.address, that.address)
  },
  [Hash.symbol](this: InetAddressV6): number {
    return Hash.combine(
      Hash.combine(Hash.hash(this.address), Hash.number(this.port)),
      Hash.number(this.scopeId)
    )
  },
  toString(this: InetAddressV6): string {
    return formatInet(this)
  },
  toJSON(this: InetAddressV6): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: InetAddressV6): string {
    return this.toJSON()
  }
}

const checkPort = (port: number): boolean => Number.isInteger(port) && port >= 0 && port <= 0xffff

/**
 * Creates a checked IPv4 internet address.
 *
 * @category constructors
 * @since 4.0.0
 */
export const inetAddressV4 = (address: Ipv4Address, port: number): Result.Result<InetAddressV4, NetAddressError> => {
  if (!checkPort(port)) {
    return addressError(address, "port must be an integer from 0 through 65535")
  }
  const self = Object.create(InetV4Proto)
  self.address = address
  self.port = port
  return Result.succeed(Object.freeze(self))
}

/**
 * Creates a checked IPv6 internet address with an optional scope identifier.
 *
 * @category constructors
 * @since 4.0.0
 */
export const inetAddressV6 = (
  address: Ipv6Address,
  port: number,
  options?: { readonly scopeId?: number | undefined }
): Result.Result<InetAddressV6, NetAddressError> => {
  if (!checkPort(port)) {
    return addressError(address, "port must be an integer from 0 through 65535")
  }
  const scopeId = options?.scopeId ?? 0
  if (!Number.isInteger(scopeId) || scopeId < 0 || scopeId > 0xffffffff) {
    return addressError(address, "scopeId must be an unsigned 32-bit integer")
  }
  const self = Object.create(InetV6Proto)
  self.address = address
  self.port = port
  self.scopeId = scopeId
  return Result.succeed(Object.freeze(self))
}

/**
 * Creates a checked internet address for an IP address and port.
 *
 * @category constructors
 * @since 4.0.0
 */
export const inetAddress = (address: IpAddress, port: number): Result.Result<InetAddress, NetAddressError> =>
  isIpv4Address(address) ? inetAddressV4(address, port) : inetAddressV6(address, port)

/**
 * Creates an internet address from a trusted IP address and port, throwing on failure.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const inetAddressUnsafe = (address: IpAddress, port: number): InetAddress =>
  Result.getOrThrow(inetAddress(address, port))

/**
 * Creates a checked internet address from a numeric IP string and port.
 *
 * **Gotchas**
 *
 * The address must be a numeric IPv4 or IPv6 literal. This function does not
 * resolve hostnames or accept IPv6 brackets.
 *
 * @category constructors
 * @since 4.0.0
 */
export const inetAddressFromIpString = (
  address: string,
  port: number
): Result.Result<InetAddress, NetAddressError> => {
  return Result.flatMap(ipFromString(address), (address) => inetAddress(address, port))
}

/**
 * Creates an internet address from a trusted numeric IP string and port.
 *
 * **Gotchas**
 *
 * This function throws when either input is invalid. Use only when both values
 * are already known to satisfy the checked constructor's requirements.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const inetAddressFromIpStringUnsafe = (address: string, port: number): InetAddress =>
  Result.getOrThrow(inetAddressFromIpString(address, port))

/**
 * Parses `IPv4:port` or `[IPv6]:port` without DNS resolution.
 *
 * @category decoding
 * @since 4.0.0
 */
export const inetAddressFromString = (input: string): Result.Result<InetAddress, NetAddressError> => {
  let host: string
  let portText: string
  let scopeId = 0
  const bracketed = input.startsWith("[")
  if (bracketed) {
    const end = input.indexOf("]")
    if (end < 0 || input[end + 1] !== ":" || input.indexOf("]", end + 1) !== -1) {
      return addressError(input, "expected [IPv6]:port")
    }
    host = input.slice(1, end)
    portText = input.slice(end + 2)
    const scopeSeparator = host.indexOf("%")
    if (scopeSeparator !== -1) {
      const scopeText = host.slice(scopeSeparator + 1)
      if (host.indexOf("%", scopeSeparator + 1) !== -1 || !/^\d+$/.test(scopeText)) {
        return addressError(input, "scope identifier must be decimal")
      }
      scopeId = Number(scopeText)
      if (!Number.isInteger(scopeId) || scopeId > 0xffffffff) {
        return addressError(input, "scope identifier must be an unsigned 32-bit integer")
      }
      host = host.slice(0, scopeSeparator)
    }
  } else {
    const separator = input.lastIndexOf(":")
    if (separator < 0) {
      return addressError(input, "expected host:port or [IPv6]:port")
    }
    if (input.indexOf(":") !== separator) {
      return addressError(input, "IPv6 addresses must be bracketed")
    }
    host = input.slice(0, separator)
    portText = input.slice(separator + 1)
  }
  if (!/^(0|[1-9]\d*)$/.test(portText)) {
    return addressError(input, "port must be an unpadded decimal integer")
  }
  return Result.flatMap(ipFromString(host), (address): Result.Result<InetAddress, NetAddressError> => {
    if (bracketed !== isIpv6Address(address)) {
      return addressError(input, "only IPv6 addresses use brackets")
    }
    return isIpv6Address(address)
      ? inetAddressV6(address, Number(portText), { scopeId })
      : inetAddressV4(address, Number(portText))
  })
}

/**
 * Parses a trusted numeric internet address and port, throwing on failure.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const inetAddressFromStringUnsafe = (input: string): InetAddress =>
  Result.getOrThrow(inetAddressFromString(input))

/**
 * Formats a resolved internet address, bracketing IPv6 around its port.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatInet = (self: InetAddress): string => {
  if (self._tag === "InetAddressV4") return `${formatIp(self.address)}:${self.port}`
  const scope = self.scopeId === 0 ? "" : `%${self.scopeId}`
  return `[${formatIp(self.address)}${scope}]:${self.port}`
}

/**
 * Formats an IP address for use as a URL authority host.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatUrlHost = (self: IpAddress): string => isIpv4Address(self) ? formatIp(self) : `[${formatIp(self)}]`

/**
 * Converts an IP address or internet socket address to a WHATWG `URL`.
 *
 * **Details**
 *
 * Defaults to the HTTP scheme and uses standard URL normalization, including
 * IPv6 brackets and omission of default ports. Bare IP addresses have no
 * explicit port; internet socket addresses retain their port, including zero.
 * Unspecified addresses are preserved.
 *
 * **Gotchas**
 *
 * Returns a `NetAddressError` for scoped IPv6 addresses or inputs that the URL
 * constructor rejects. Supply the scheme without a trailing colon, for example
 * `"https"`.
 *
 * @category conversions
 * @since 4.0.0
 */
export const toUrl = (self: IpAddress | InetAddress, scheme: string = "http"): Result.Result<URL, NetAddressError> => {
  if (self._tag === "InetAddressV6" && self.scopeId !== 0) {
    return addressError(self, "scoped IPv6 addresses are not supported by WHATWG URLs")
  }
  return Result.try({
    try: () => new URL(`${scheme}://${isInetAddress(self) ? formatInet(self) : formatUrlHost(self)}`),
    catch: (cause) => new NetAddressError({ input: self, message: "failed to construct URL", cause })
  })
}

/**
 * Formats an IP or socket address as a URL display string.
 *
 * **Details**
 *
 * Defaults to HTTP, brackets IPv6 addresses, and omits default ports and the
 * trailing slash. Custom schemes such as `"tcp"` retain their scheme and host.
 * Unix socket addresses use {@link formatUnixPath}, preserving the raw path
 * with a `unix://` prefix regardless of the supplied scheme.
 *
 * **Gotchas**
 *
 * Returns a `NetAddressError` when URL conversion fails, including for scoped
 * IPv6 addresses.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatUrl = (
  self: IpAddress | SocketAddress,
  scheme: string = "http"
): Result.Result<string, NetAddressError> =>
  isUnixPathAddress(self)
    ? Result.succeed(formatUnixPath(self))
    : Result.map(toUrl(self, scheme), (url) => `${url.protocol}//${url.host}`)

/**
 * Formats an IP or socket address as a URL display string,
 * throwing a `NetAddressError` when conversion fails.
 *
 * @see {@link formatUrl} for the checked version and formatting behavior.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const formatUrlUnsafe = (self: IpAddress | SocketAddress, scheme: string = "http"): string =>
  Result.getOrThrow(formatUrl(self, scheme))

/**
 * Formats a hostname or numeric IP address for use as a URL authority host.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatUrlHostString = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host

const UnixPathProto = {
  _tag: "UnixPathAddress",
  [TypeId]: TypeId,
  [Equal.symbol](this: UnixPathAddress, that: Equal.Equal): boolean {
    return isUnixPathAddress(that) && this.path === that.path
  },
  [Hash.symbol](this: UnixPathAddress): number {
    return Hash.combine(Hash.string("UnixPathAddress"), Hash.string(this.path))
  },
  toString(this: UnixPathAddress): string {
    return this.path
  },
  toJSON(this: UnixPathAddress): string {
    return this.toString()
  },
  [NodeInspectSymbol](this: UnixPathAddress): string {
    return this.toJSON()
  }
}

/**
 * Creates a Unix-domain filesystem address without normalizing its opaque path.
 *
 * @category constructors
 * @since 4.0.0
 */
export const unixPathAddress = (path: string): UnixPathAddress => {
  const self = Object.create(UnixPathProto)
  self.path = path
  return Object.freeze(self)
}

/**
 * Formats a Unix-domain socket path as a readable `unix://path` display string.
 *
 * **Details**
 *
 * Preserves the raw path without URL encoding or normalization. The resulting
 * string is intended for display.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatUnixPath = (self: UnixPathAddress): string => `unix://${self.path}`

/**
 * Converts a `SocketAddress.Input` to a concrete socket address.
 *
 * **Details**
 *
 * Numeric IP strings are parsed without hostname resolution. Invalid IP
 * literals, ports, and input shapes return a `NetAddressError`.
 *
 * @category constructors
 * @since 4.0.0
 */
export const socketAddressFromInput = (
  input: SocketAddress.Input
): Result.Result<SocketAddress, NetAddressError> => {
  if (isSocketAddress(input)) return Result.succeed(input)
  if (typeof input === "string") return inetAddressFromString(input)
  if (hasProperty(input, "path")) {
    return typeof input.path === "string"
      ? Result.succeed(unixPathAddress(input.path))
      : addressError(input, "path must be a string")
  }
  if (!hasProperty(input, "address") || !hasProperty(input, "port")) {
    return addressError(input, "expected an address and port or a Unix path")
  }
  const address = typeof input.address === "string"
    ? ipFromString(input.address)
    : isIpAddress(input.address)
    ? Result.succeed(input.address)
    : addressError(input, "address must be an IP address or numeric IP string")
  return Result.flatMap(address, (address) => inetAddress(address, input.port as number))
}

/**
 * Converts a trusted `SocketAddress.Input` to a concrete socket address,
 * throwing on failure.
 *
 * @category unsafe
 * @since 4.0.0
 */
export const socketAddressFromInputUnsafe = (input: SocketAddress.Input): SocketAddress =>
  Result.getOrThrow(socketAddressFromInput(input))

/**
 * Formats a portable socket address for human-readable output.
 *
 * @category encoding
 * @since 4.0.0
 */
export const formatSocketAddress = (self: SocketAddress): string =>
  self._tag === "UnixPathAddress" ? self.path : formatInet(self)
