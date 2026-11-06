// Usage: node plant-saved-connection.mjs plant|check --state-dir DIR --platform darwin|linux --password PASSWORD
// Windows is not needed: DPAPI moves with Electron's userData folder.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const IV = Buffer.alloc(16, 0x20);
const TOKEN = "plant-test-token-ominax";

function valueKey(platform, password) {
  if (platform === "darwin") return NodeCrypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
  return NodeCrypto.pbkdf2Sync(password || "peanuts", "saltysalt", 1, 16, "sha1");
}

function encrypt(value, platform, password) {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", valueKey(platform, password), IV);
  const prefix = platform === "linux" && password ? "v11" : "v10";
  return Buffer.concat([Buffer.from(prefix), cipher.update(value, "utf8"), cipher.final()]);
}

function decrypt(value, platform, password) {
  const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", valueKey(platform, password), IV);
  return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString("utf8");
}

function catalog() {
  return {
    schemaVersion: 1,
    targets: [
      {
        _tag: "BearerConnectionTarget",
        environmentId: "planted-box",
        label: "Planted box",
        connectionId: "bearer:planted-box",
      },
    ],
    profiles: [
      {
        _tag: "BearerConnectionProfile",
        connectionId: "bearer:planted-box",
        environmentId: "planted-box",
        label: "Planted box",
        httpBaseUrl: "http://127.0.0.1:3780",
        wsBaseUrl: "ws://127.0.0.1:3780",
      },
    ],
    credentials: [
      {
        connectionId: "bearer:planted-box",
        credential: { _tag: "BearerConnectionCredential", token: TOKEN },
      },
    ],
    remoteDpopTokens: [],
    disabledEnvironmentIds: [],
  };
}

function args(argv) {
  const command = argv[2];
  const values = {};
  for (let i = 3; i < argv.length; i += 2) values[argv[i].slice(2)] = argv[i + 1];
  if (!command || !values["state-dir"] || !["darwin", "linux"].includes(values.platform)) {
    throw new Error(
      "usage: plant|check --state-dir DIR --platform darwin|linux --password PASSWORD",
    );
  }
  return {
    command,
    stateDir: values["state-dir"],
    platform: values.platform,
    password: values.password ?? "",
  };
}

function main(input) {
  const file = NodePath.join(input.stateDir, "connection-catalog.json");
  NodeFS.mkdirSync(input.stateDir, { recursive: true });
  if (input.command === "plant") {
    const encryptedCatalog = encrypt(
      JSON.stringify(catalog()),
      input.platform,
      input.password,
    ).toString("base64");
    NodeFS.writeFileSync(file, `${JSON.stringify({ version: 1, encryptedCatalog })}\n`);
    console.log("planted Planted box");
    return;
  }
  if (input.command !== "check") throw new Error(`unknown command: ${input.command}`);
  const document = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const decoded = JSON.parse(
    decrypt(Buffer.from(document.encryptedCatalog, "base64"), input.platform, input.password),
  );
  const found =
    decoded.targets?.some((target) => target.label === "Planted box") &&
    decoded.credentials?.some((entry) => entry.credential?.token === TOKEN);
  if (!found || !NodeFS.existsSync(`${file}.pre-ominax`))
    throw new Error("saved connection migration not found");
  console.log("checked Planted box and migration backup");
}

if (process.argv[1]?.endsWith("plant-saved-connection.mjs")) {
  try {
    main(args(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

export { decrypt, encrypt, TOKEN };
