/**
 * `actionsCost` against rows measured in EFF-3738, one per charge it makes:
 * each row is the `actions` block's elements as posted, and what the 13,200
 * cap charged for it, found by bisecting the text beside it.
 */
import { cost, type Element, option } from "@effect/chat-slack/internal/actions"
import { assert, describe, it } from "@effect/vitest"

const opts = (n: number, label = (i: number) => "Option " + i, value = (i: number) => "o" + i) =>
  Array.from({ length: n }, (_, i) => option(label(i + 1), value(i + 1)))

const S = (o: {
  readonly id?: string
  readonly ph?: string | null
  readonly options?: ReadonlyArray<ReturnType<typeof option>>
  readonly initial?: ReturnType<typeof option>
} = {}): Element => ({
  type: "static_select",
  action_id: o.id ?? "sel1",
  ...(o.ph === null ? {} : { placeholder: { type: "plain_text", text: o.ph ?? "Pick one" } }),
  options: o.options ?? opts(3),
  ...(o.initial === undefined ? {} : { initial_option: o.initial })
})

const B = (o: {
  readonly id?: string
  readonly label?: string
  readonly url?: string
  readonly value?: string | null
} = {}): Element => ({
  type: "button",
  text: { type: "plain_text", text: o.label ?? "Test button" },
  action_id: o.id ?? "eff3738_noop",
  ...(o.url === undefined ? {} : { url: o.url }),
  ...(o.value === null ? {} : { value: o.value ?? "v" })
})

const one = (label: string) => opts(1, () => label, () => "a")

/** Name, elements, what Slack charged, and whether every string in it is ASCII. */
const rows: ReadonlyArray<readonly [string, ReadonlyArray<Element>, number, boolean]> = [
  ["V1", [S({ options: one("A"), ph: null })], 173, true],
  ["V2", [S({ options: one("A") })], 240, true],
  ["V6", [S({ options: opts(10, () => "A", () => "a") })], 843, true],
  ["V10", [S({ options: opts(3), initial: option("Option 2", "o2") })], 490, true],
  ["V15", [B(), S({ options: opts(3) }), B({ id: "b2" })], 628, true],
  ["V18", [S({ options: one("é".repeat(20)) })], 359, false],
  ["V20", [B()], 170, true],
  ["V21", [B({ url: "https://effect.website/docs", value: null })], 197, true],
  ["V22", [B({ url: "https://effect.website/docs", value: "v" })], 209, true],
  ["W1", [B({ label: "é".repeat(20) })], 279, false],
  ["W2", [B({ label: "\u{1F644}" })], 183, false],
  ["W4", [S({ options: one("A"), ph: "\u{1F644}" })], 256, false],
  ["W8", [B({ label: "<&>".repeat(10) })], 289, true],
  ["W13", [S({ options: one("\u{1D49C}".repeat(5)) })], 299, false]
]

describe("actionsCost", () => {
  it("is never below what Slack charged, and at most 5 over on ASCII, for the measured rows", () => {
    for (const [name, elements, charged, ascii] of rows) {
      const charge = cost(elements)
      assert.isAtLeast(charge, charged, name)
      if (ascii) assert.isAtMost(charge, charged + 5, name)
    }
  })
})
