import { Order } from "effect"
import { describe, expect, it } from "tstyche"

describe("Order", () => {
  it("Tuple", () => {
    const O = Order.Tuple([Order.Number, Order.String])
    expect(O).type.toBe<Order.Order<readonly [number, string]>>()
  })

  it("Array", () => {
    const O = Order.Array(Order.Number)
    expect(O).type.toBe<Order.Order<ReadonlyArray<number>>>()
  })

  it("Struct", () => {
    const key = Symbol()
    const O = Order.Struct({ a: Order.Number, b: Order.String, [key]: Order.Boolean })
    expect(O).type.toBe<Order.Order<{ readonly a: number; readonly b: string; readonly [key]: boolean }>>()

    const fields = { a: Order.Number, b: Order.String, [key]: Order.Boolean }
    expect(Order.Struct(fields)).type.toBe<typeof O>()

    expect(Order.Struct).type.not.toBeCallableWith({ [key]: 42 })
    expect(Order.Struct).type.not.toBeCallableWith(42)
    expect(Order.Struct).type.not.toBeCallableWith("value")
    expect(Order.Struct).type.not.toBeCallableWith([Order.Number])
  })

  it("Struct accepts string record aliases", () => {
    type Fields = {
      [key: string]: Order.Order<number>
    }
    const fields: Fields = { age: Order.Number }

    expect(Order.Struct).type.toBeCallableWith(fields)
  })
})
