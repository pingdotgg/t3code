import { describe, expect, it } from "@effect/vitest";
import { makeExpectContinueObserver } from "../../proxy/ExpectContinue.ts";

const run = (chunks: ReadonlyArray<string>) => {
  let continues = 0;
  const observer = makeExpectContinueObserver(() => {
    continues++;
  });
  for (const chunk of chunks) observer.observe(Buffer.from(chunk, "latin1"));
  return { continues, stopped: observer.stopped };
};

const put = (headers: string, body = "") =>
  `PUT /x HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n${body}`;

describe("ExpectContinue observer", () => {
  it("answers a request head that expects 100-continue", () => {
    expect(
      run([put("Content-Length: 5\r\nExpect: 100-continue\r\n", "hello")]),
    ).toEqual({ continues: 1, stopped: false });
  });

  it("matches the expectation case-insensitively", () => {
    expect(
      run([put("content-length: 1\r\nEXPECT: 100-Continue\r\n", "x")])
        .continues,
    ).toBe(1);
  });

  it("ignores requests without the expectation", () => {
    expect(run([put("Content-Length: 5\r\n", "hello")]).continues).toBe(0);
  });

  it("ignores HTTP/1.0 expectations", () => {
    expect(
      run([
        "PUT /x HTTP/1.0\r\nContent-Length: 1\r\nExpect: 100-continue\r\n\r\nx",
      ]).continues,
    ).toBe(0);
  });

  it("finds a head split across chunks, byte by byte", () => {
    const request = put("Content-Length: 3\r\nExpect: 100-continue\r\n", "abc");
    expect(run(request.split("")).continues).toBe(1);
  });

  it("does not mistake body bytes for a request head", () => {
    // The body contains something that looks like a head with the expectation
    const fake = "PUT /y HTTP/1.1\r\nExpect: 100-continue\r\n\r\n";
    expect(
      run([put(`Content-Length: ${fake.length}\r\n`, fake)]).continues,
    ).toBe(0);
  });

  it("tracks keep-alive requests after a Content-Length body", () => {
    expect(
      run([
        put("Content-Length: 2\r\n", "ab"),
        put("Content-Length: 1\r\nExpect: 100-continue\r\n", "x"),
        put("Content-Length: 1\r\nExpect: 100-continue\r\n"),
      ]).continues,
    ).toBe(2);
  });

  it("tracks keep-alive requests after a chunked body with trailers", () => {
    const chunked = put(
      "Transfer-Encoding: chunked\r\nExpect: 100-continue\r\n",
      "5;ext=1\r\nhello\r\n3\r\n\r\n\r\n\r\n0\r\nX-Trailer: 1\r\n\r\n",
    );
    expect(
      run([chunked, put("Content-Length: 1\r\nExpect: 100-continue\r\n", "x")]),
    ).toEqual({ continues: 2, stopped: false });
  });

  it("tolerates CRLFs between messages", () => {
    expect(
      run([
        put("Content-Length: 0\r\n"),
        "\r\n",
        put("Content-Length: 1\r\nExpect: 100-continue\r\n", "x"),
      ]).continues,
    ).toBe(1);
  });

  it("stops at an upgrade and never inspects the tunnel", () => {
    const result = run([
      "GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      put("Content-Length: 1\r\nExpect: 100-continue\r\n", "x"),
    ]);
    expect(result).toEqual({ continues: 0, stopped: true });
  });

  it("stops on a malformed head or framing", () => {
    expect(run(["garbage\r\n\r\n"]).stopped).toBe(true);
    expect(run([put("Content-Length: nope\r\n")]).stopped).toBe(true);
    expect(run([put("Transfer-Encoding: chunked\r\n", "zz\r\n")]).stopped).toBe(
      true,
    );
    expect(run([put("Transfer-Encoding: gzip\r\n")]).stopped).toBe(true);
  });

  it("stops on an oversized head", () => {
    expect(
      run([`PUT /x HTTP/1.1\r\nX: ${"a".repeat(70 * 1024)}`]).stopped,
    ).toBe(true);
  });
});
