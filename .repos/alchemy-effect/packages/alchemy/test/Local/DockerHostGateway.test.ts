import { isLoopbackHost } from "@/Local/DockerHostGateway";
import { describe, expect, it } from "alchemy-test";

describe("Docker loopback hosts", () => {
  it("recognizes loopback and localhost-looking hosts", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("host.docker.localhost")).toBe(true);
    expect(isLoopbackHost("db.example.com")).toBe(false);
    expect(
      isLoopbackHost("ep-cool-name-123456-pooler.us-east-1.aws.neon.tech"),
    ).toBe(false);
    expect(isLoopbackHost("xxxx.pg.psdb.cloud")).toBe(false);
    expect(isLoopbackHost("aws.connect.psdb.cloud")).toBe(false);
  });
});
