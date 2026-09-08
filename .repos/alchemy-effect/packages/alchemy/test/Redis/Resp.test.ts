import { describe, expect, test } from "alchemy-test";
import {
  decode,
  decodeAll,
  encodeArray,
  encodeBoolean,
  encodeBulk,
  encodeCommand,
  encodeDouble,
  encodeError,
  encodeInteger,
  encodeNull,
  encodeNullArray,
  encodeReply,
  encodeSimpleString,
  Parser,
  type ParseResult,
  type Reply,
} from "@/Redis/Resp.ts";
import { ProtocolError, ReplyError } from "@/Redis/Errors.ts";

const utf8 = new TextEncoder();
const bytes = (value: string): Uint8Array => utf8.encode(value);

const asReply = (input: Uint8Array | string): Reply => {
  const result = decode(input);
  if (result._tag !== "Reply") {
    throw new Error(`expected Reply, got ${JSON.stringify(result)}`);
  }
  return result.value;
};

const asError = (input: Uint8Array | string): ReplyError => {
  const result = decode(input);
  if (result._tag !== "Error") {
    throw new Error(`expected Error, got ${JSON.stringify(result)}`);
  }
  return result.error;
};

const drain = (input: Uint8Array, size: number): ParseResult[] => {
  const parser = new Parser();
  const frames: ParseResult[] = [];
  for (let offset = 0; offset < input.length; offset += size) {
    parser.push(input.subarray(offset, offset + size));
    while (true) {
      const next = parser.next();
      if (next._tag === "Incomplete") break;
      frames.push(next);
      if (next._tag === "Protocol") return frames;
    }
  }
  return frames;
};

describe("encodeCommand", () => {
  test("PING is an array of bulk strings", () => {
    expect(encodeCommand("PING")).toEqual(bytes("*1\r\n$4\r\nPING\r\n"));
  });

  test("LLEN mylist matches the RESP2 spec example", () => {
    expect(encodeCommand("LLEN", ["mylist"])).toEqual(
      bytes("*2\r\n$4\r\nLLEN\r\n$6\r\nmylist\r\n"),
    );
  });

  test("bulk length is bytes, not JS string length", () => {
    const encoded = encodeCommand("SET", ["k", "😀"]);
    expect(encoded).toEqual(
      bytes("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\n😀\r\n"),
    );
  });

  test("binary args are length-prefixed without scanning", () => {
    const payload = new Uint8Array([0, 13, 10, 36, 42]);
    const encoded = encodeCommand("SET", ["bin", payload]);
    const prefix = bytes("*3\r\n$3\r\nSET\r\n$3\r\nbin\r\n$5\r\n");
    const expected = new Uint8Array(prefix.length + payload.length + 2);
    expected.set(prefix, 0);
    expected.set(payload, prefix.length);
    expected.set([13, 10], prefix.length + payload.length);
    expect(encoded).toEqual(expected);
  });
});

describe("RESP2 decode", () => {
  test("simple string", () => {
    expect(asReply("+OK\r\n")).toBe("OK");
    expect(asReply("+\r\n")).toBe("");
  });

  test("error prefix and message", () => {
    const error = asError("-ERR unknown command 'foobar'\r\n");
    expect(error).toBeInstanceOf(ReplyError);
    expect(error.code).toBe("ERR");
    expect(error.message).toBe("ERR unknown command 'foobar'");
    const wrongType = asError(
      "-WRONGTYPE Operation against a key holding the wrong kind of value\r\n",
    );
    expect(wrongType.code).toBe("WRONGTYPE");
  });

  test("integers including negative", () => {
    expect(asReply(":0\r\n")).toBe(0);
    expect(asReply(":1000\r\n")).toBe(1000);
    expect(asReply(":-1\r\n")).toBe(-1);
    expect(asReply(":48293\r\n")).toBe(48293);
  });

  test("integers outside MAX_SAFE_INTEGER become bigint", () => {
    expect(asReply(":9007199254740993\r\n")).toBe(9007199254740993n);
  });

  test("null bulk and empty bulk", () => {
    expect(asReply("$-1\r\n")).toBeNull();
    expect(asReply("$0\r\n\r\n")).toBe("");
  });

  test("bulk string with CR LF $ * inside", () => {
    expect(asReply("$6\r\nfoobar\r\n")).toBe("foobar");
    const payload = "\r\n$*";
    expect(asReply(encodeBulk(payload))).toBe(payload);
  });

  test("null array, empty array, mixed array, nested array", () => {
    expect(asReply("*-1\r\n")).toBeNull();
    expect(asReply("*0\r\n")).toEqual([]);
    expect(asReply("*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n")).toEqual(["foo", "bar"]);
    expect(asReply("*3\r\n:1\r\n:2\r\n:3\r\n")).toEqual([1, 2, 3]);
    expect(asReply("*5\r\n:1\r\n:2\r\n:3\r\n:4\r\n$6\r\nfoobar\r\n")).toEqual([
      1,
      2,
      3,
      4,
      "foobar",
    ]);
    const nested = asReply(
      "*2\r\n*3\r\n:1\r\n:2\r\n:3\r\n*2\r\n+Foo\r\n-Bar\r\n",
    );
    expect(Array.isArray(nested)).toBe(true);
    const [first, second] = nested as Reply[];
    expect(first).toEqual([1, 2, 3]);
    expect(Array.isArray(second)).toBe(true);
    const pair = second as Reply[];
    expect(pair[0]).toBe("Foo");
    expect(pair[1]).toBeInstanceOf(ReplyError);
    expect((pair[1] as ReplyError).code).toBe("Bar");
  });

  test("null element in array", () => {
    expect(asReply("*3\r\n$3\r\nfoo\r\n$-1\r\n$3\r\nbar\r\n")).toEqual([
      "foo",
      null,
      "bar",
    ]);
  });

  test("round-trip encodeReply", () => {
    const value: Reply = ["ok", 3, null, ["nested"]];
    expect(asReply(encodeReply(value))).toEqual(value);
  });
});

describe("RESP3 decode", () => {
  test("null boolean double big number", () => {
    expect(asReply("_\r\n")).toBeNull();
    expect(asReply("#t\r\n")).toBe(true);
    expect(asReply("#f\r\n")).toBe(false);
    expect(asReply(",1.23\r\n")).toBe(1.23);
    expect(asReply(",inf\r\n")).toBe(Infinity);
    expect(asReply(",-inf\r\n")).toBe(-Infinity);
    expect(Number.isNaN(asReply(",nan\r\n") as number)).toBe(true);
    expect(asReply("(3492890328409238509324850943850943825024385\r\n")).toBe(
      3492890328409238509324850943850943825024385n,
    );
  });

  test("verbatim string strips the encoding prefix", () => {
    expect(asReply("=15\r\ntxt:Some string\r\n")).toBe("Some string");
  });

  test("map with string keys becomes an object", () => {
    expect(asReply("%2\r\n+first\r\n:1\r\n+second\r\n:2\r\n")).toEqual({
      first: 1,
      second: 2,
    });
  });

  test("set is an array", () => {
    expect(asReply("~2\r\n+orange\r\n+apple\r\n")).toEqual(["orange", "apple"]);
  });

  test("attributes are skipped and the following value is returned", () => {
    expect(asReply("|1\r\n+ttl\r\n:3600\r\n:3\r\n")).toBe(3);
  });

  test("push frames are tagged", () => {
    const result = decode(">2\r\n+message\r\n+chan\r\n");
    expect(result).toEqual({
      _tag: "Push",
      value: ["message", "chan"],
    });
  });

  test("blob error", () => {
    const result = decode("!21\r\nSYNTAX invalid syntax\r\n");
    expect(result._tag).toBe("Error");
    if (result._tag === "Error") {
      expect(result.error.code).toBe("SYNTAX");
      expect(result.error.message).toBe("SYNTAX invalid syntax");
    }
  });

  test("streamed string", () => {
    expect(
      asReply("$?\r\n;5\r\nHello\r\n;1\r\n \r\n;5\r\nworld\r\n;0\r\n"),
    ).toBe("Hello world");
  });

  test("streamed array", () => {
    expect(asReply("*?\r\n:1\r\n:2\r\n:3\r\n.\r\n")).toEqual([1, 2, 3]);
  });
});

describe("incremental parser", () => {
  test("replies split one byte at a time", () => {
    const payload = encodeArray([
      encodeBulk("foo"),
      encodeNull(),
      encodeInteger(2),
      encodeSimpleString("OK"),
    ]);
    const frames = drain(payload, 1);
    expect(frames).toEqual([{ _tag: "Reply", value: ["foo", null, 2, "OK"] }]);
  });

  test("bulk payload split across chunks", () => {
    const parser = new Parser();
    parser.push(bytes("$6\r\nfoo"));
    expect(parser.next()._tag).toBe("Incomplete");
    parser.push(bytes("bar\r\n"));
    expect(parser.next()).toEqual({ _tag: "Reply", value: "foobar" });
  });

  test("multiple replies in one buffer", () => {
    const frames = decodeAll("+OK\r\n:1\r\n$4\r\nPONG\r\n");
    expect(frames).toEqual([
      { _tag: "Reply", value: "OK" },
      { _tag: "Reply", value: 1 },
      { _tag: "Reply", value: "PONG" },
    ]);
  });

  test("CRLF split across chunks", () => {
    const parser = new Parser();
    parser.push(bytes("+OK\r"));
    expect(parser.next()._tag).toBe("Incomplete");
    parser.push(bytes("\n"));
    expect(parser.next()).toEqual({ _tag: "Reply", value: "OK" });
  });
});

describe("protocol errors", () => {
  test("unknown type byte", () => {
    const result = decode("xOK\r\n");
    expect(result._tag).toBe("Protocol");
    if (result._tag === "Protocol") {
      expect(result.error).toBeInstanceOf(ProtocolError);
    }
  });

  test("incomplete value", () => {
    const result = decode("$6\r\nfoo");
    expect(result._tag).toBe("Protocol");
  });

  test("encode helpers used by servers", () => {
    expect(asReply(encodeBoolean(true))).toBe(true);
    expect(asReply(encodeDouble(1.5))).toBe(1.5);
    expect(asError(encodeError("ERR boom")).code).toBe("ERR");
    expect(asReply(encodeNull())).toBeNull();
    expect(asReply(encodeNullArray())).toBeNull();
  });
});
