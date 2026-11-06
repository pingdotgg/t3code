// Usage: node plant-saved-connection.mjs plant|check [--state-dir DIR] [--platform darwin|linux|win32] [--password PASSWORD]
// This is standalone because release install tests run it before app dependencies exist.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TOKEN = "plant-test-token-ominax";
const IV = Buffer.alloc(16, 0x20);
const MARKER = "connection-catalog.json.ominax-install-skipped";

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

function valueKey(platform, password) {
  return NodeCrypto.pbkdf2Sync(
    password || "peanuts",
    "saltysalt",
    platform === "darwin" ? 1003 : 1,
    16,
    "sha1",
  );
}
function encrypt(value, platform, password) {
  const cipher = NodeCrypto.createCipheriv("aes-128-cbc", valueKey(platform, password), IV);
  return Buffer.concat([
    Buffer.from(platform === "linux" && password ? "v11" : "v10"),
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);
}
function decrypt(value, platform, password) {
  const decipher = NodeCrypto.createDecipheriv("aes-128-cbc", valueKey(platform, password), IV);
  return Buffer.concat([decipher.update(value.subarray(3)), decipher.final()]).toString("utf8");
}
function encryptWindows(value, key) {
  const nonce = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([
    Buffer.from("v10"),
    nonce,
    cipher.update(value, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}
function decryptWindows(value, key) {
  if (value.subarray(0, 3).toString() !== "v10") throw new Error("unsupported Windows secret");
  const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, value.subarray(3, 15));
  decipher.setAuthTag(value.subarray(-16));
  return Buffer.concat([decipher.update(value.subarray(15, -16)), decipher.final()]).toString(
    "utf8",
  );
}
function darwinPassword(service, account, override) {
  return (
    override ||
    NodeChildProcess.execFileSync(
      "security",
      ["find-generic-password", "-w", "-s", service, "-a", account],
      { encoding: "utf8" },
    ).trim()
  );
}
function windowsKey(userData) {
  const localState = NodePath.join(userData, "Local State");
  if (!NodeFS.existsSync(localState)) return null;
  const encrypted = JSON.parse(NodeFS.readFileSync(localState, "utf8")).os_crypt?.encrypted_key;
  if (typeof encrypted !== "string") throw new Error("Local State has no os_crypt key");
  // -Command splices trailing arguments into the script, so the key goes in on stdin.
  const script =
    "Add-Type -AssemblyName System.Security;$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());$b=$b[5..($b.Length-1)];[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return Buffer.from(
    NodeChildProcess.execFileSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", input: encrypted },
    ).trim(),
    "base64",
  );
}
function parseArgs(argv) {
  const command = argv[2];
  const values = {};
  for (let i = 3; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined)
      throw new Error("flags must be --name value");
    values[argv[i].slice(2)] = argv[i + 1];
  }
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone release test script has no Effect runtime.
  const platform = values.platform || process.platform;
  if (
    !command ||
    !["plant", "check"].includes(command) ||
    !["darwin", "linux", "win32"].includes(platform)
  )
    throw new Error(
      "usage: plant|check [--state-dir DIR] [--platform darwin|linux|win32] [--password PASSWORD]",
    );
  const home = process.env.HOME || process.env.USERPROFILE || NodeOS.homedir();
  const appData = process.env.APPDATA || NodePath.join(home, "AppData", "Roaming");
  const userData =
    platform === "win32"
      ? NodePath.join(appData, command === "plant" ? "t3learn" : "ominax")
      : null;
  const defaultState = NodePath.join(
    home,
    command === "plant" ? ".t3-learn" : ".ominax",
    "userdata",
  );
  const stateDir = values["state-dir"] || defaultState;
  return {
    command,
    platform,
    password: values.password || "",
    stateDir,
    userData: userData || NodePath.dirname(NodePath.dirname(stateDir)),
  };
}
function main(input) {
  const file = NodePath.join(input.stateDir, "connection-catalog.json");
  // check must never create folders: an early ~/.ominax would make the app skip its migration.
  if (input.command === "plant") NodeFS.mkdirSync(input.stateDir, { recursive: true });
  let key;
  if (input.platform === "win32") {
    const plantedMarker = NodePath.join(
      process.env.USERPROFILE || process.env.HOME || NodeOS.homedir(),
      ".t3-learn",
      "userdata",
      MARKER,
    );
    if (input.command === "check" && NodeFS.existsSync(plantedMarker)) {
      console.log("skipped saved connection check: Windows Local State was absent during plant");
      return;
    }
    key = windowsKey(input.userData);
    if (key === null) {
      if (input.command === "plant") {
        NodeFS.writeFileSync(NodePath.join(input.stateDir, MARKER), "skipped\n");
        console.log("skipped saved connection: Windows Local State does not exist yet");
        return;
      }
      throw new Error("Windows Local State is missing after the plant was not skipped");
    }
  }
  if (input.command === "plant") {
    const password =
      input.platform === "darwin"
        ? darwinPassword("t3learn Safe Storage", "t3learn Key", input.password)
        : input.password;
    const encryptedCatalog = (
      input.platform === "win32"
        ? encryptWindows(JSON.stringify(catalog()), key)
        : encrypt(JSON.stringify(catalog()), input.platform, password)
    ).toString("base64");
    NodeFS.writeFileSync(file, `${JSON.stringify({ version: 1, encryptedCatalog })}\n`);
    console.log("planted Planted box");
    return;
  }
  if (input.platform === "linux") {
    const currentHome = NodePath.dirname(input.stateDir);
    const legacyHome = NodePath.join(NodePath.dirname(currentHome), ".t3-learn");
    if (
      !NodeFS.statSync(currentHome).isDirectory() ||
      !NodeFS.lstatSync(legacyHome).isSymbolicLink()
    ) {
      throw new Error("OminaX home migration not found");
    }
    if (NodeFS.realpathSync(legacyHome) !== NodeFS.realpathSync(currentHome)) {
      throw new Error("legacy T3 Learn home does not link to OminaX home");
    }
  }
  const document = JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const password =
    input.platform === "darwin"
      ? darwinPassword("ominax Safe Storage", "ominax Key", input.password)
      : input.password;
  const decoded = JSON.parse(
    input.platform === "win32"
      ? decryptWindows(Buffer.from(document.encryptedCatalog, "base64"), key)
      : decrypt(Buffer.from(document.encryptedCatalog, "base64"), input.platform, password),
  );
  const found =
    decoded.targets?.some((target) => target.label === "Planted box") &&
    decoded.credentials?.some((entry) => entry.credential?.token === TOKEN);
  const backupRequired =
    input.platform === "darwin" || (input.platform === "linux" && Boolean(input.password));
  if (!found || (backupRequired && !NodeFS.existsSync(`${file}.pre-ominax`)))
    throw new Error("saved connection migration not found");
  console.log(
    `checked Planted box${backupRequired ? " and migration backup" : ""}${input.platform === "linux" && !input.password ? " (shared Linux key)" : ""} in ${input.stateDir}`,
  );
}
if (process.argv[1]?.endsWith("plant-saved-connection.mjs")) {
  try {
    main(parseArgs(process.argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
export { decrypt, encrypt, TOKEN };
