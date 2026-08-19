import { describe, expect, it } from "vite-plus/test";

import { parseDevRunnerLine, parsePairingUrl, redactSecrets, webOrigin } from "./devOutput.ts";

describe("dev output parsers", () => {
  it("reads ports and baseDir from the [dev-runner] line", () => {
    const parsed = parseDevRunnerLine(
      "[dev-runner] mode=dev source=worktree serverPort=13773 webPort=5733 baseDir=/tmp/t3code-e2e-home",
    );
    expect(parsed).toEqual({
      serverPort: 13773,
      webPort: 5733,
      baseDir: "/tmp/t3code-e2e-home",
    });
  });

  it("reads ports when the source includes a worktree path", () => {
    const parsed = parseDevRunnerLine(
      "[16:10:54.064] INFO (#1): [dev-runner] mode=dev source=worktree /Users/mark/.t3/worktrees/t3-code/t3code-896032cf serverPort=16218 webPort=8178 baseDir=/tmp/t3code-e2e-home",
    );
    expect(parsed).toEqual({
      serverPort: 16218,
      webPort: 8178,
      baseDir: "/tmp/t3code-e2e-home",
    });
  });

  it("reads ports when the runner selected a shifted offset", () => {
    const parsed = parseDevRunnerLine(
      "[dev-runner] mode=dev source=worktree selectedOffset(server=2,web=2) serverPort=13775 webPort=5735 baseDir=/tmp/home",
    );
    expect(parsed?.serverPort).toBe(13775);
    expect(parsed?.webPort).toBe(5735);
  });

  it("extracts a pairing URL from Effect log annotations", () => {
    const url = parsePairingUrl(
      "Authentication required. Open T3 Code using the pairing URL.\n  pairingUrl: http://localhost:8178/pair#token=secret-token\n",
    );
    expect(url).toBe("http://localhost:8178/pair#token=secret-token");
  });

  it("extracts a pairing URL from mixed server logs", () => {
    const url = parsePairingUrl(
      "Authentication required. pairingUrl=http://localhost:5733/pair#token=secret-token\n",
    );
    expect(url).toBe("http://localhost:5733/pair#token=secret-token");
  });

  it("extracts the Pairing URL console line", () => {
    const url = parsePairingUrl("Pairing URL: http://127.0.0.1:5733/pair#token=abc\n");
    expect(url).toBe("http://127.0.0.1:5733/pair#token=abc");
  });

  it("redacts pairing tokens before logs or error messages", () => {
    expect(redactSecrets("open http://localhost:5733/pair#token=super-secret then continue")).toBe(
      "open http://localhost:5733/pair#token=REDACTED then continue",
    );
  });

  it("builds the web origin from the printed webPort", () => {
    expect(webOrigin(5733)).toBe("http://localhost:5733");
  });
});
