import { Effect, type Result, Schema } from "effect"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { describe, expect, it } from "tstyche"

describe("NetAddress", () => {
  it("exposes checked and throwing constructors", () => {
    expect(NetAddress.macAddressFromString("00:00:5e:00:53:01")).type.toBe<
      Result.Result<NetAddress.MacAddress, NetAddress.NetAddressError>
    >()
    expect(NetAddress.macAddressFromStringUnsafe("00:00:5e:00:53:01")).type.toBe<NetAddress.MacAddress>()
    expect(NetAddress.ipFromString("::1")).type.toBe<Result.Result<NetAddress.IpAddress, NetAddress.NetAddressError>>()
    expect(NetAddress.ipFromStringUnsafe("::1")).type.toBe<NetAddress.IpAddress>()
    expect(NetAddress.inetAddressUnsafe(NetAddress.ipv6Loopback, 80)).type.toBe<NetAddress.InetAddress>()
    expect(NetAddress.inetAddressFromStringUnsafe("[::1]:80")).type.toBe<NetAddress.InetAddress>()
    expect(NetAddress.socketAddressFromInput({ address: "::1", port: 80 })).type.toBe<
      Result.Result<NetAddress.SocketAddress, NetAddress.NetAddressError>
    >()
    expect(NetAddress.socketAddressFromInput("127.0.0.1:3000")).type.toBe<
      Result.Result<NetAddress.SocketAddress, NetAddress.NetAddressError>
    >()
    expect(NetAddress.socketAddressFromInputUnsafe({ path: "server.sock" })).type.toBe<NetAddress.SocketAddress>()
    expect(NetAddress.ipv4FromBytesUnsafe(new Uint8Array(4))).type.toBe<NetAddress.Ipv4Address>()
    expect(NetAddress.ipv6FromBytesUnsafe(new Uint8Array(16))).type.toBe<NetAddress.Ipv6Address>()
    expect(NetAddress.ipv4FromOctets([127, 0, 0, 1])).type.toBe<
      Result.Result<NetAddress.Ipv4Address, NetAddress.NetAddressError>
    >()
    expect(NetAddress.ipv6FromSegments([0, 0, 0, 0, 0, 0, 0, 1])).type.toBe<
      Result.Result<NetAddress.Ipv6Address, NetAddress.NetAddressError>
    >()
    expect(NetAddress.macAddressFromOctets([0, 0, 0, 0, 0, 0])).type.toBe<
      Result.Result<NetAddress.MacAddress, NetAddress.NetAddressError>
    >()
    // @ts-expect-error Source has 3 element(s) but target requires 4.
    NetAddress.ipv4FromOctets([127, 0, 1])
    expect(NetAddress.ipv6ToOctets(NetAddress.ipv6Loopback)).type.toBe<ReadonlyArray<number>>()
    // @ts-expect-error Property 'bytes' does not exist
    void NetAddress.ipv4Loopback.bytes
  })

  it("requires canonical socket addresses at consumer constructors", () => {
    const server = HttpServer.make({
      address: NetAddress.inetAddressUnsafe(NetAddress.ipv4Loopback, 8080),
      serve: () => Effect.void
    })
    expect(server.address).type.toBe<NetAddress.SocketAddress>()

    HttpServer.make({
      // @ts-expect-error Type 'string' is not assignable to type 'Ipv6Address'
      address: { address: "localhost", port: 8080 },
      serve: () => Effect.void
    })
  })

  it("converts internet addresses to URLs and exposes rejected inputs", () => {
    const address = NetAddress.inetAddressUnsafe(NetAddress.ipv6Unspecified, 80)
    expect(NetAddress.toUrl(address)).type.toBe<Result.Result<URL, NetAddress.NetAddressError>>()
    expect(NetAddress.toUrl(address, undefined)).type.toBe<Result.Result<URL, NetAddress.NetAddressError>>()
    expect(NetAddress.toUrl(address, "https")).type.toBe<Result.Result<URL, NetAddress.NetAddressError>>()
    const unix = NetAddress.unixPathAddress("server.sock")
    expect(NetAddress.toUrl(NetAddress.ipv4Loopback)).type.toBe<Result.Result<URL, NetAddress.NetAddressError>>()
    expect(NetAddress.toUrl(NetAddress.ipv6Loopback, "https")).type.toBe<
      Result.Result<URL, NetAddress.NetAddressError>
    >()
    expect(NetAddress.toUrl).type.not.toBeCallableWith(unix)
    expect(NetAddress.toUrl).type.not.toBeCallableWith(unix, "http")
    expect(NetAddress.formatUrl(address)).type.toBe<Result.Result<string, NetAddress.NetAddressError>>()
    expect(NetAddress.formatUrl(NetAddress.ipv4Loopback, "https")).type.toBe<
      Result.Result<string, NetAddress.NetAddressError>
    >()
    expect(NetAddress.formatUrl(unix)).type.toBe<Result.Result<string, NetAddress.NetAddressError>>()
    expect(NetAddress.formatUrlUnsafe(address)).type.toBe<string>()
    expect(NetAddress.formatUrlUnsafe(NetAddress.ipv4Loopback, "https")).type.toBe<string>()
    expect(NetAddress.formatUrlUnsafe(unix)).type.toBe<string>()
    expect(NetAddress.formatUnixPath(unix)).type.toBe<string>()
    expect(new NetAddress.NetAddressError({ input: address, message: "invalid" }).input).type.toBe<unknown>()
  })

  it("narrows address unions", () => {
    const address = null as unknown as NetAddress.SocketAddress
    if (NetAddress.isUnixPathAddress(address)) {
      expect(address).type.toBe<NetAddress.UnixPathAddress>()
    } else if (NetAddress.isInetAddressV4(address)) {
      expect(address.address).type.toBe<NetAddress.Ipv4Address>()
    } else {
      expect(address.address).type.toBe<NetAddress.Ipv6Address>()
    }
  })

  it("preserves named schema types when annotating codecs", () => {
    expect(Schema.MacAddressFromString.annotate({ identifier: "custom" })).type.toBe<Schema.MacAddressFromString>()
    expect(Schema.Ipv4AddressFromString.annotate({ identifier: "custom" })).type.toBe<Schema.Ipv4AddressFromString>()
    expect(Schema.Ipv6AddressFromString.annotate({ identifier: "custom" })).type.toBe<Schema.Ipv6AddressFromString>()
    expect(Schema.IpAddressFromString.annotate({ identifier: "custom" })).type.toBe<Schema.IpAddressFromString>()
    expect(Schema.Ipv4InterfaceFromString.annotate({ identifier: "custom" })).type.toBe<
      Schema.Ipv4InterfaceFromString
    >()
    expect(Schema.Ipv6InterfaceFromString.annotate({ identifier: "custom" })).type.toBe<
      Schema.Ipv6InterfaceFromString
    >()
    expect(Schema.IpInterfaceFromString.annotate({ identifier: "custom" })).type.toBe<Schema.IpInterfaceFromString>()
    expect(Schema.Ipv4NetworkFromString.annotate({ identifier: "custom" })).type.toBe<Schema.Ipv4NetworkFromString>()
    expect(Schema.Ipv6NetworkFromString.annotate({ identifier: "custom" })).type.toBe<Schema.Ipv6NetworkFromString>()
    expect(Schema.IpNetworkFromString.annotate({ identifier: "custom" })).type.toBe<Schema.IpNetworkFromString>()
    expect(Schema.InetAddressFromString.annotate({ identifier: "custom" })).type.toBe<Schema.InetAddressFromString>()
    expect(Schema.UnixPathAddressFromString.annotate({ identifier: "custom" })).type.toBe<
      Schema.UnixPathAddressFromString
    >()
  })

  it("exposes string transformation schemas", () => {
    expect(Schema.MacAddressFromString).type.toBeAssignableTo<Schema.Codec<NetAddress.MacAddress, string>>()
    expect(Schema.IpAddressFromString).type.toBeAssignableTo<Schema.Codec<NetAddress.IpAddress, string>>()
    expect(Schema.InetAddressFromString).type.toBeAssignableTo<Schema.Codec<NetAddress.InetAddress, string>>()
    expect(Schema.UnixPathAddressFromString).type.toBeAssignableTo<
      Schema.Codec<NetAddress.UnixPathAddress, string>
    >()
  })
})
