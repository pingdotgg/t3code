import { canonicalCidr } from "@/Utils/ip-address.ts";
import { describe, expect, test } from "alchemy-test";

const valid: [string, string][] = [
  ["10.0.0.7/16", "10.0.0.0/16"],
  ["10.0.0.7/016", "10.0.0.0/16"],
  ["10.0.0.1/024", "10.0.0.0/24"],
  ["::1/064", "::/64"],
  ["10.0.0.1/00", "0.0.0.0/0"],
  ["::1/000", "::/0"],
  ["192.168.1.255/24", "192.168.1.0/24"],
  ["172.31.255.255/12", "172.16.0.0/12"],
  ["192.0.2.129/25", "192.0.2.128/25"],
  ["192.0.2.131/31", "192.0.2.130/31"],
  ["192.0.2.131/32", "192.0.2.131/32"],
  ["255.255.255.255/0", "0.0.0.0/0"],
  ["255.255.255.255/1", "128.0.0.0/1"],
  ["255.255.255.255/32", "255.255.255.255/32"],
  ["0.0.0.0/32", "0.0.0.0/32"],
  ["::/0", "::/0"],
  ["::/128", "::/128"],
  ["::1/128", "::1/128"],
  ["::1/127", "::/127"],
  ["FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF/0", "::/0"],
  ["FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF/1", "8000::/1"],
  [
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/127",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:fffe/127",
  ],
  [
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
    "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff/128",
  ],
  ["2001:0DB8:0000:0000:0000:0000:0000:0001/128", "2001:db8::1/128"],
  ["2001:db8:abcd:1234:5678:9abc:def0:1234/64", "2001:db8:abcd:1234::/64"],
  ["2001:db8:abcd:1234:ffff:ffff:ffff:ffff/65", "2001:db8:abcd:1234:8000::/65"],
  ["2001:db8:abcd:1234:ffff:ffff:ffff:ffff/63", "2001:db8:abcd:1234::/63"],
  ["1:0:0:2:0:0:3:4/128", "1::2:0:0:3:4/128"],
  ["1:0:0:2:0:0:0:4/128", "1:0:0:2::4/128"],
  ["0:0:1:2:3:4:0:0/128", "::1:2:3:4:0:0/128"],
  ["1:2:3:4:5:6:0:0/128", "1:2:3:4:5:6::/128"],
  ["1:2:3:4:5:6:0:8/128", "1:2:3:4:5:6:0:8/128"],
  ["1:2:3:4:5:6::8/128", "1:2:3:4:5:6:0:8/128"],
  ["::ffff:192.0.2.129/128", "::ffff:c000:281/128"],
  ["::ffff:192.0.2.129/120", "::ffff:c000:200/120"],
  ["::ffff:192.0.2.129/96", "::ffff:0:0/96"],
  ["::ffff:192.0.2.129/80", "::/80"],
  ["::192.0.2.129/120", "::c000:200/120"],
  ["0:0:0:0:0:FFFF:192.0.2.129/128", "::ffff:c000:281/128"],
  ["1:2:3:4:5:6:192.0.2.1/128", "1:2:3:4:5:6:c000:201/128"],
  ["1:2:3:4:5::192.0.2.1/128", "1:2:3:4:5:0:c000:201/128"],
];

const invalid = [
  "",
  "10.0.0.1",
  "::1",
  "/24",
  "/128",
  "10.0.0.1/",
  "::1/",
  "10.0.0.1/33",
  "::1/129",
  "10.0.0.1/-1",
  "::1/-1",
  "10.0.0.1/+24",
  "::1/+64",
  "10.0.0.1/24.0",
  "::1/6.4",
  "10.0.0.1/2e1",
  "::1/0x40",
  "10.0.0.1/NaN",
  "::1/Infinity",
  "10.0.0.1/24/1",
  "::1/64/1",
  "10.0.0.1//24",
  "::1//64",
  "10.0.0/24",
  "10.0.0.1.2/24",
  "256.0.0.1/24",
  "10.256.0.1/24",
  "10.0.256.1/24",
  "10.0.0.256/24",
  "10..0.1/24",
  ".10.0.1/24",
  "10.0.1./24",
  "-1.0.0.1/24",
  "+1.0.0.1/24",
  "1e1.0.0.1/24",
  "0x0a.0.0.1/24",
  "010.0.0.1/24",
  "10.00.0.1/24",
  "10.0.0.01/24",
  "10.a.0.1/24",
  "１０.0.0.1/24",
  "localhost/24",
  "[::1]/128",
  "fe80::1%eth0/64",
  "fe80::1%1/64",
  ":/64",
  ":::/64",
  "::::/64",
  ":1:2:3:4:5:6:7/64",
  "1:2:3:4:5:6:7:/64",
  "1::2::3/64",
  "1:2:3:4:5:6:7/64",
  "1:2:3:4:5:6:7:8:9/64",
  "1:2:3:4:5:6:7:8::/64",
  "::1:2:3:4:5:6:7:8/64",
  "1:2:3:4::5:6:7:8/64",
  "1:2:3:4:5:6:12345:8/128",
  "1:2:3:4:5:6:gggg:8/128",
  "1:2:3:4:5:6:0x1:8/128",
  "1:2:3:4:5:6:+1:8/128",
  "1:2:3:4:5:6:-1:8/128",
  "::ffff:256.0.0.1/128",
  "::ffff:192.0.2/128",
  "::ffff:192.0.2.1.2/128",
  "::ffff:192.0.02.1/128",
  "192.0.2.1::/128",
  "::192.0.2.1:1/128",
  "1:2:3:4:5:192.0.2.1/128",
  "1:2:3:4:5:6:7:192.0.2.1/128",
  "1:2:3:4:5:6::192.0.2.1/128",
  "::1:2:3:4:5:6:192.0.2.1/128",
];

const ipv4Bits = (address: string) =>
  address
    .split(".")
    .map((octet) => Number(octet).toString(2).padStart(8, "0"))
    .join("");

const ipv6Bits = (address: string) => {
  const [left, right] = address.split("::");
  const head = left ? left.split(":") : [];
  const tail = right ? right.split(":") : [];
  const words =
    right === undefined
      ? head
      : [
          ...head,
          ...Array<string>(8 - head.length - tail.length).fill("0"),
          ...tail,
        ];
  return words
    .map((word) => parseInt(word, 16).toString(2).padStart(16, "0"))
    .join("");
};

describe("canonicalCidr", () => {
  test("preserves undefined", () => {
    expect(canonicalCidr(undefined)).toBeUndefined();
  });

  for (const [input, expected] of valid) {
    test(`canonicalizes ${input}`, () => {
      expect(canonicalCidr(input)).toBe(expected);
      expect(canonicalCidr(expected)).toBe(expected);
    });
  }

  for (const input of invalid) {
    test(`preserves invalid input ${JSON.stringify(input)}`, () => {
      expect(canonicalCidr(input)).toBe(input);
    });
  }

  test("preserves whitespace rather than interpreting a different address", () => {
    for (const whitespace of [
      " ",
      "\t",
      "\n",
      "\r",
      "\r\n",
      "\u00a0",
      "\ufeff",
    ]) {
      for (const base of ["10.0.0.1/24", "2001:db8::1/64"]) {
        for (let index = 0; index <= base.length; index++) {
          const input = base.slice(0, index) + whitespace + base.slice(index);
          expect(canonicalCidr(input)).toBe(input);
        }
      }
    }
  });

  test("preserves oversized inputs without throwing", () => {
    for (const input of [
      `10.0.0.1/${"9".repeat(1000)}`,
      `::1/${"9".repeat(1000)}`,
      `${"1:".repeat(1000)}1/64`,
      `${"1.".repeat(1000)}1/24`,
      `${"f".repeat(1000)}::/64`,
    ])
      expect(canonicalCidr(input)).toBe(input);
  });

  test("masks every IPv4 prefix and is idempotent", () => {
    for (const address of [
      "0.0.0.0",
      "255.255.255.255",
      "170.85.170.85",
      "85.170.85.170",
      "192.168.171.205",
    ]) {
      const bits = ipv4Bits(address);
      for (let prefix = 0; prefix <= 32; prefix++) {
        const result = canonicalCidr(`${address}/${prefix}`)!;
        const [network, actualPrefix] = result.split("/");
        expect(actualPrefix).toBe(String(prefix));
        expect(ipv4Bits(network!)).toBe(bits.slice(0, prefix).padEnd(32, "0"));
        expect(canonicalCidr(result)).toBe(result);
      }
    }
  });

  test("masks every IPv6 prefix and is idempotent", () => {
    for (const address of [
      "0:0:0:0:0:0:0:0",
      "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "aaaa:5555:aaaa:5555:aaaa:5555:aaaa:5555",
      "5555:aaaa:5555:aaaa:5555:aaaa:5555:aaaa",
      "2001:db8:abcd:1234:5678:9abc:def0:1234",
    ]) {
      const bits = ipv6Bits(address);
      for (let prefix = 0; prefix <= 128; prefix++) {
        const result = canonicalCidr(`${address}/${prefix}`)!;
        const [network, actualPrefix] = result.split("/");
        expect(actualPrefix).toBe(String(prefix));
        expect(ipv6Bits(network!)).toBe(bits.slice(0, prefix).padEnd(128, "0"));
        expect(canonicalCidr(result)).toBe(result);
      }
    }
  });

  test("handles every IPv4 octet value in every position", () => {
    for (let index = 0; index < 4; index++) {
      for (let value = 0; value <= 255; value++) {
        const octets = [1, 2, 3, 4];
        octets[index] = value;
        const input = `${octets.join(".")}/32`;
        expect(canonicalCidr(input)).toBe(input);
      }
    }
  });

  test("handles every 16-bit IPv6 word in every position, including case and leading zeros", () => {
    for (let index = 0; index < 8; index++) {
      for (let value = 0; value <= 65535; value++) {
        const words = ["1", "2", "3", "4", "5", "6", "7", "8"];
        words[index] = value.toString(16);
        const expected = `${words.join(":")}/128`;
        words[index] = value.toString(16).toUpperCase().padStart(4, "0");
        expect(canonicalCidr(`${words.join(":")}/128`)).toBe(expected);
      }
    }
  });

  test("normalizes every valid position and length of IPv6 zero compression", () => {
    for (let start = 0; start < 8; start++) {
      for (let length = 1; length <= 8 - start; length++) {
        const words = Array.from({ length: 8 }, (_, index) =>
          index >= start && index < start + length ? "0" : String(index + 1),
        );
        const expanded = words.join(":");
        const compressed = `${words.slice(0, start).join(":")}::${words.slice(start + length).join(":")}`;
        const expected = `${length === 1 ? expanded : compressed}/128`;
        expect(canonicalCidr(`${expanded}/128`)).toBe(expected);
        expect(canonicalCidr(`${compressed}/128`)).toBe(expected);
      }
    }
  });

  test("chooses the first longest zero run across all 256 IPv6 zero/nonzero word patterns", () => {
    for (let pattern = 0; pattern < 256; pattern++) {
      const expanded = Array.from({ length: 8 }, (_, index) =>
        pattern & (1 << index) ? "0" : String(index + 1),
      ).join(":");
      const runs = Array.from(expanded.matchAll(/(?:^|:)0(?::0)+(?=:|$)/g))
        .map((match) => ({
          start: match.index + (match[0].startsWith(":") ? 1 : 0),
          text: match[0].replace(/^:/, ""),
        }))
        .sort((a, b) => b.text.length - a.text.length);
      const longest = runs[0];
      const expected =
        longest === undefined
          ? expanded
          : `${expanded.slice(0, longest.start).replace(/:$/, "")}::${expanded.slice(longest.start + longest.text.length).replace(/^:/, "")}`;
      expect(canonicalCidr(`${expanded}/128`)).toBe(`${expected}/128`);
    }
  });

  test("masks embedded IPv4 addresses identically to their hexadecimal form at every prefix", () => {
    for (let prefix = 0; prefix <= 128; prefix++) {
      expect(canonicalCidr(`::ffff:192.0.2.129/${prefix}`)).toBe(
        canonicalCidr(`0:0:0:0:0:ffff:c000:281/${prefix}`),
      );
      expect(canonicalCidr(`1:2:3:4:5:6:192.0.2.129/${prefix}`)).toBe(
        canonicalCidr(`1:2:3:4:5:6:c000:281/${prefix}`),
      );
    }
  });
});
