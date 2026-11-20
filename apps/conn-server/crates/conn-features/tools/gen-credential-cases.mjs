// Characterizations of T3's test-login fill rules: `matchingOrigin` and `parseSavedUrl`
// (credentialOrigin.ts) and `parseTotpSetup` / `totpCode` (totp.ts), run by the Rust tests.
//   node crates/conn-features/tools/gen-credential-cases.mjs [--check]
import * as fs from "node:fs";
import { importSource } from "../../../tools/monorepo.mjs";

const origin = await importSource("apps/server/src/credentials/credentialOrigin.ts");
const totp = await importSource("apps/server/src/credentials/totp.ts");
const out = new URL("../src/test_logins/credential-cases.json", import.meta.url);
const cases = [];
const saved = [
  "example.com", "https://example.com/login", "http://example.com", "www.example.com",
  "https://example.com:8443", "localhost:3000", "app.test", "127.0.0.1:8000", "[::1]:5173",
  "ftp://example.com", "  ", "not a url", "https://WWW.Example.COM/", "dev.localhost",
  "\u0085myapp.test", "\u00a0example.com\ufeff", "\u2028example.com",
];
const tabs = [
  "https://example.com/", "http://example.com/", "https://www.example.com/x",
  "https://example.com:8443/", "https://sub.example.com/", "http://localhost:3000/",
  "https://localhost:3000/", "http://app.test/", "https://app.test/", "http://127.0.0.1:8000/", "https://myapp.test/",
  "http://[::1]:5173/", "about:blank", "https://example.com:443/", "http://dev.localhost/",
];
for (const url of saved) for (const tab of tabs) {
  cases.push({ kind: "origin", saved: [url], tab, expected: origin.matchingOrigin([url], tab) });
}
for (const url of saved) {
  const target = origin.parseSavedUrl(url);
  cases.push({ kind: "savedHost", saved: url, expected: target?.host ?? null });
}
const now = 1_766_000_123_456;
for (const setup of [
  "JBSWY3DPEHPK3PXP", "jbsw y3dp-ehpk 3pxp====", "", "not base32!",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256",
  "otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=sha512&digits=7",
  "otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=9",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=md5",
  "OTPAUTH://TOTP/x?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=1.5",
  "otpauth://totp:123/x?secret=JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0x1e",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=%2030%20", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=3e1",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=Infinity", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=0b110", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=inf",
  "\u0085JBSWY3DPEHPK3PXP", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=0x%2B6",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0x10000000000000000", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0x",
  "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0X1E", "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&period=0b2",
]) {
  const parsed = totp.parseTotpSetup(setup);
  cases.push({ kind: "totp", setup, now, expected: parsed === null ? null : totp.totpCode(parsed, now) });
}
const text = `[\n${cases.map((c) => JSON.stringify(c)).join(",\n")}\n]\n`;
if (process.argv.includes("--check")) {
  if (fs.readFileSync(out, "utf8") !== text) throw new Error("credential rules changed; run gen-credential-cases.mjs and port the difference");
  console.log(`credential characterizations: ${cases.length} T3 cases current`);
} else {
  fs.writeFileSync(out, text);
  console.log(`recorded ${cases.length} credential characterizations`);
}
