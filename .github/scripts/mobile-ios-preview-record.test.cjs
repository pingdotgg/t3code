const assert = require("node:assert/strict");
const test = require("node:test");
const { createRecord, readClient } = require("./mobile-ios-preview-record.cjs");

test("only clients with an unexpired provisioning profile are reused", () => {
  const link = "https://expo.dev/accounts/pingdotgg/projects/t3-code/builds/client";
  const profile =
    "<plist><dict><key>ExpirationDate</key><date>2027-01-01T00:00:00Z</date></dict></plist>";
  const record = createRecord(link, profile);
  assert.equal(readClient(record, Date.parse("2026-12-31T00:00:00Z")), link);
  assert.equal(readClient(record, Date.parse("2027-01-01T00:00:00Z")), "");
  assert.equal(readClient(record, Date.parse("2027-01-02T00:00:00Z")), "");
  for (const invalid of [link, "{}", "null", JSON.stringify({ link, expiresAt: "invalid" })]) {
    assert.equal(readClient(invalid, 0), "");
  }
  assert.throws(() => createRecord(link, "<plist></plist>"), /ExpirationDate/);
});
