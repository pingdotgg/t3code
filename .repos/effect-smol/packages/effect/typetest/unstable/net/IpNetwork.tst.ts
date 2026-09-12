import type { Result, Schema } from "effect"
import * as IpInterface from "effect/unstable/net/IpInterface"
import * as IpNetwork from "effect/unstable/net/IpNetwork"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { describe, expect, it } from "tstyche"

describe("IpNetwork", () => {
  it("preserves address families in checked constructors", () => {
    expect(IpNetwork.make(NetAddress.ipv4Unspecified, 0)).type.toBe<
      Result.Result<IpNetwork.Ipv4Network, NetAddress.NetAddressError>
    >()
    expect(IpNetwork.make(NetAddress.ipv6Unspecified, 0)).type.toBe<
      Result.Result<IpNetwork.Ipv6Network, NetAddress.NetAddressError>
    >()
    expect(IpNetwork.fromAddress(NetAddress.ipv4Unspecified, 0)).type.toBe<
      Result.Result<IpNetwork.Ipv4Network, NetAddress.NetAddressError>
    >()
    expect(IpNetwork.fromInterface(IpInterface.makeUnsafe(NetAddress.ipv4Unspecified, 0))).type.toBe<
      IpNetwork.Ipv4Network
    >()
    expect(IpNetwork.fromInterface(IpInterface.makeUnsafe(NetAddress.ipv6Unspecified, 0))).type.toBe<
      IpNetwork.Ipv6Network
    >()
    const ipv4Network = IpNetwork.makeUnsafe(NetAddress.ipv4Unspecified, 0)
    expect(IpNetwork.firstAddress(ipv4Network)).type.toBe<NetAddress.Ipv4Address>()
    expect(IpNetwork.lastAddress(ipv4Network)).type.toBe<NetAddress.Ipv4Address>()
    const address = null as unknown as NetAddress.IpAddress
    expect(IpNetwork.make(address, 0)).type.toBe<Result.Result<IpNetwork.IpNetwork, NetAddress.NetAddressError>>()
    expect(IpNetwork.fromAddress(address, 0)).type.toBe<
      Result.Result<IpNetwork.IpNetwork, NetAddress.NetAddressError>
    >()
  })

  it("preserves families in parsers and unsafe constructors", () => {
    expect(IpNetwork.ipv4FromString("0.0.0.0/0")).type.toBe<
      Result.Result<IpNetwork.Ipv4Network, NetAddress.NetAddressError>
    >()
    expect(IpNetwork.ipv6FromString("::/0")).type.toBe<
      Result.Result<IpNetwork.Ipv6Network, NetAddress.NetAddressError>
    >()
    expect(IpNetwork.fromString("::/0")).type.toBe<Result.Result<IpNetwork.IpNetwork, NetAddress.NetAddressError>>()
    expect(IpNetwork.makeUnsafe(NetAddress.ipv4Unspecified, 0)).type.toBe<IpNetwork.Ipv4Network>()
    expect(IpNetwork.fromAddressUnsafe(NetAddress.ipv6Unspecified, 0)).type.toBe<IpNetwork.Ipv6Network>()
    expect(IpNetwork.fromStringUnsafe("::/0")).type.toBe<IpNetwork.IpNetwork>()
  })

  it("narrows generic networks", () => {
    const value = null as unknown as IpNetwork.IpNetwork
    if (IpNetwork.isIpv4Network(value)) {
      expect(value.address).type.toBe<NetAddress.Ipv4Address>()
    } else if (IpNetwork.isIpv6Network(value)) {
      expect(value.address).type.toBe<NetAddress.Ipv6Address>()
    }
  })

  it("supports both predicate call forms", () => {
    const value = null as unknown as IpNetwork.IpNetwork
    const address = null as unknown as NetAddress.IpAddress
    expect(IpNetwork.contains(value, address)).type.toBe<boolean>()
    expect(IpNetwork.contains(address)(value)).type.toBe<boolean>()
    expect(IpNetwork.containsNetwork(value, value)).type.toBe<boolean>()
    expect(IpNetwork.containsNetwork(value)(value)).type.toBe<boolean>()
    expect(IpNetwork.overlaps(value, value)).type.toBe<boolean>()
    expect(IpNetwork.overlaps(value)(value)).type.toBe<boolean>()
  })

  it("preserves exact Schema types", () => {
    expect<Schema.Schema.Type<typeof Schema.Ipv4NetworkFromString>>().type.toBe<IpNetwork.Ipv4Network>()
    expect<Schema.Schema.Type<typeof Schema.Ipv6NetworkFromString>>().type.toBe<IpNetwork.Ipv6Network>()
    expect<Schema.Schema.Type<typeof Schema.IpNetworkFromString>>().type.toBe<IpNetwork.IpNetwork>()
    expect<Schema.Codec.Encoded<typeof Schema.IpNetworkFromString>>().type.toBe<string>()
  })
})
