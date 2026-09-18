import type { Result, Schema } from "effect"
import * as IpInterface from "effect/unstable/net/IpInterface"
import * as IpNetwork from "effect/unstable/net/IpNetwork"
import * as NetAddress from "effect/unstable/net/NetAddress"
import { describe, expect, it } from "tstyche"

describe("IpInterface", () => {
  it("preserves address families", () => {
    expect(IpInterface.make(NetAddress.ipv4Unspecified, 0)).type.toBe<
      Result.Result<IpInterface.IpInterface<NetAddress.Ipv4Address>, NetAddress.NetAddressError>
    >()
    expect(IpInterface.make(NetAddress.ipv6Unspecified, 0)).type.toBe<
      Result.Result<IpInterface.IpInterface<NetAddress.Ipv6Address>, NetAddress.NetAddressError>
    >()
    expect(IpInterface.ipv4FromString("127.0.0.1/8")).type.toBe<
      Result.Result<IpInterface.Ipv4Interface, NetAddress.NetAddressError>
    >()
    const ipv4 = IpInterface.makeUnsafe(NetAddress.ipv4Unspecified, 0)
    expect(IpNetwork.fromInterface(ipv4)).type.toBe<IpNetwork.Ipv4Network>()
  })

  it("narrows generic interface addresses", () => {
    const value = null as unknown as IpInterface.IpInterface
    if (IpInterface.isIpv4Interface(value)) {
      expect(value.address).type.toBe<NetAddress.Ipv4Address>()
    } else if (IpInterface.isIpv6Interface(value)) {
      expect(value.address).type.toBe<NetAddress.Ipv6Address>()
    }
  })

  it("preserves exact Schema types", () => {
    expect<Schema.Schema.Type<typeof Schema.Ipv4InterfaceFromString>>().type.toBe<IpInterface.Ipv4Interface>()
    expect<Schema.Schema.Type<typeof Schema.Ipv6InterfaceFromString>>().type.toBe<IpInterface.Ipv6Interface>()
    expect<Schema.Schema.Type<typeof Schema.IpInterfaceFromString>>().type.toBe<IpInterface.IpInterface>()
  })
})
