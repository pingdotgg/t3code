import { ByteSize, type ByteSize as ByteSizeType, type Config, type Option, type Schema } from "effect"
import { describe, expect, it } from "tstyche"

declare const value: ByteSizeType.ByteSize

describe("ByteSize", () => {
  it("distinguishes decimal and binary units", () => {
    expect("B").type.toBeAssignableTo<ByteSizeType.DecimalUnit>()
    expect("B").type.toBeAssignableTo<ByteSizeType.BinaryUnit>()
    expect("kB").type.toBeAssignableTo<ByteSizeType.DecimalUnit>()
    expect("kB").type.not.toBeAssignableTo<ByteSizeType.BinaryUnit>()
    expect("KiB").type.toBeAssignableTo<ByteSizeType.BinaryUnit>()
    expect("KiB").type.not.toBeAssignableTo<ByteSizeType.DecimalUnit>()
  })

  it("requires the format unit to match the system", () => {
    expect({ system: "decimal", unit: "kB" } as const).type.toBeAssignableTo<ByteSizeType.FormatOptions>()
    expect({ system: "binary", unit: "KiB" } as const).type.toBeAssignableTo<ByteSizeType.FormatOptions>()
    expect({ unit: "kB" } as const).type.toBeAssignableTo<ByteSizeType.FormatOptions>()
    expect({ unit: "KiB" } as const).type.toBeAssignableTo<ByteSizeType.FormatOptions>()
    expect({ system: "decimal", unit: "KiB" } as const).type.not.toBeAssignableTo<ByteSizeType.FormatOptions>()
    expect({ system: "binary", unit: "kB" } as const).type.not.toBeAssignableTo<ByteSizeType.FormatOptions>()
  })

  it("infers data-last arithmetic", () => {
    expect(value).type.toBeAssignableTo<bigint>()
    expect<bigint>().type.not.toBeAssignableTo<ByteSizeType.ByteSize>()
    expect(ByteSize.sum(value)(value)).type.toBe<ByteSizeType.ByteSize>()
    expect(ByteSize.times(2)(value)).type.toBe<Option.Option<ByteSizeType.ByteSize>>()
  })

  it("integrates with Schema and Config", () => {
    expect<Schema.Schema.Type<typeof Schema.ByteSize>>().type.toBe<ByteSizeType.ByteSize>()
    expect<Schema.Codec.Encoded<typeof Schema.ByteSizeFromString>>().type.toBe<string>()
    expect<ReturnType<typeof Config.ByteSize>>().type.toBe<Config.Config<ByteSizeType.ByteSize>>()
  })
})
