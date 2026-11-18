const { readFileSync } = require("node:fs");

function readClient(value, now = Date.now()) {
  try {
    const record = JSON.parse(value);
    return typeof record?.link === "string" && Date.parse(record.expiresAt) > now
      ? record.link
      : "";
  } catch {
    return "";
  }
}

function createRecord(link, profile) {
  const expiration = /<key>ExpirationDate<\/key>\s*<date>([^<]+)<\/date>/.exec(profile)?.[1];
  if (!expiration || !Number.isFinite(Date.parse(expiration))) {
    throw new Error("The provisioning profile has no valid ExpirationDate.");
  }
  return JSON.stringify({ link, expiresAt: new Date(expiration).toISOString() });
}

if (require.main === module) {
  if (process.argv[2] === "read") {
    process.stdout.write(readClient(readFileSync(0, "utf8")));
  } else if (process.argv[2] === "create") {
    process.stdout.write(createRecord(process.argv[3], readFileSync(process.argv[4], "utf8")));
  } else {
    throw new Error("Expected read or create.");
  }
}

module.exports = { createRecord, readClient };
