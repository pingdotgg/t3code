import { describe, expect, it } from "vite-plus/test";
import { redactSshText } from "./sshTarget";

describe("SSH display redaction", () => {
  it.each([
    ["devbox", "devbox"],
    ["buildbox:2222", "buildbox:2222"],
    ["deploy@devbox", "•••@devbox"],
    ["deploy@buildbox:2222", "•••@buildbox:2222"],
    ["deploy@host.example.com", "•••@•••"],
    ["host.tail1234.ts.net", "•••"],
    ["203.0.113.42", "•••"],
    ["deploy@[2001:db8::1]:2222", "•••@[•••]:2222"],
  ])("redacts only sensitive parts of %s", (value, expected) => {
    expect(redactSshText(value)).toBe(expected);
  });

  it("preserves unrelated error text", () => {
    const message = "node.js exited at 12:34:56 with std::vector";
    expect(redactSshText(message, "devbox")).toBe(message);
  });

  it("redacts the configured hostname in passive error text", () => {
    expect(
      redactSshText(
        "Could not resolve hostname actual.example.com: Name not known",
        "actual.example.com",
      ),
    ).toBe("Could not resolve hostname •••: Name not known");
  });

  it("uses the connection destination to redact passive error text", () => {
    expect(redactSshText("deploy@devbox: Permission denied", "deploy@devbox")).toBe(
      "•••@devbox: Permission denied",
    );
  });
});
