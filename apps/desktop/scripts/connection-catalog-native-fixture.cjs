// Run with Electron, an isolated T3CODE_HOME, and an existing development web server.
// CATALOG_FIXTURE_MAIN points to dist-electron/main.cjs; CATALOG_FIXTURE_OUTPUT is
// a disposable evidence directory. Run recovery then reload in the same OS keyring.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const assert = require("node:assert/strict");

const mode = process.env.CATALOG_FIXTURE_MODE || "recovery";
const output = process.env.CATALOG_FIXTURE_OUTPUT;
const home = process.env.T3CODE_HOME;
assert(output && home && process.env.CATALOG_FIXTURE_MAIN);
assert(path.resolve(home).startsWith("/tmp/"), "Use a disposable /tmp home");
const catalogPath = path.join(home, "userdata", "connection-catalog.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fresh = JSON.stringify({
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
});
fs.mkdirSync(output, { recursive: true });
if (mode === "recovery") {
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  assert(!fs.existsSync(catalogPath), "Recovery requires a fresh fixture home");
  const source = JSON.stringify(
    {
      version: 1,
      encryptedCatalog: Buffer.concat([Buffer.from("v10"), Buffer.alloc(64, 81)]).toString(
        "base64",
      ),
    },
    null,
    2,
  );
  fs.writeFileSync(catalogPath, source);
  fs.writeFileSync(path.join(output, "source-fixture.json"), source);
}
let observed = false;
app.on("browser-window-created", (_event, window) => {
  if (observed) return;
  observed = true;
  window.webContents.once("did-finish-load", async () => {
    const steps = [];
    const record = (step, value) => {
      steps.push({ step, value });
      console.log("CATALOG_FIXTURE", JSON.stringify({ step, value }));
    };
    try {
      record("runtime", {
        electron: process.versions.electron,
        platform: os.platform(),
        available: safeStorage.isEncryptionAvailable(),
        backend: safeStorage.getSelectedStorageBackend(),
        mainSha256: hash(fs.readFileSync(process.env.CATALOG_FIXTURE_MAIN)),
      });
      assert(safeStorage.isEncryptionAvailable());
      assert.notEqual(safeStorage.getSelectedStorageBackend(), "basic_text");
      const get = () =>
        window.webContents.executeJavaScript("window.desktopBridge.getConnectionCatalog()");
      const backups = () =>
        fs.readdirSync(path.dirname(catalogPath)).filter((name) => name.endsWith(".undecryptable"));
      const original = fs.readFileSync(path.join(output, "source-fixture.json"));
      const sourceDocument = JSON.parse(original);
      const ciphertextHash = hash(Buffer.from(sourceDocument.encryptedCatalog, "base64"));
      record("source", { fileSha256: hash(original), ciphertextSha256: ciphertextHash });
      if (mode === "recovery") {
        const first = await get();
        record("firstGet", first);
        assert.equal(first, null);
        assert.deepEqual(fs.readFileSync(catalogPath), original);
        record("activeSourceUnchangedBeforeSave", true);
        const repeated = await get();
        const concurrent = await window.webContents.executeJavaScript(
          "Promise.all([window.desktopBridge.getConnectionCatalog(),window.desktopBridge.getConnectionCatalog()])",
        );
        assert.equal(repeated, null);
        assert.deepEqual(concurrent, [null, null]);
        assert.equal(backups().length, 1);
        const backup = fs.readFileSync(path.join(path.dirname(catalogPath), backups()[0]));
        fs.writeFileSync(path.join(output, "backup-fixture.json"), backup);
        assert.equal(JSON.parse(backup).encryptedCatalog, sourceDocument.encryptedCatalog);
        record("repeatAndConcurrentReads", {
          results: [repeated, ...concurrent],
          backups: backups().length,
        });
        record("preservation", {
          sourceFileSha256: hash(original),
          backupFileSha256: hash(backup),
          rawBytesEqual: original.equals(backup),
          ciphertextEqual: true,
          ciphertextSha256: ciphertextHash,
          backupName: backups()[0],
        });
        const saved = await window.webContents.executeJavaScript(
          `window.desktopBridge.setConnectionCatalog(${JSON.stringify(fresh)})`,
        );
        record("save", saved);
        assert.equal(saved, true);
      }
      const reloaded = await get();
      assert.equal(reloaded, fresh);
      const document = JSON.parse(fs.readFileSync(catalogPath));
      assert.equal(
        safeStorage.decryptString(Buffer.from(document.encryptedCatalog, "base64")),
        fresh,
      );
      assert.equal(backups().length, 1);
      const backup = fs.readFileSync(path.join(path.dirname(catalogPath), backups()[0]));
      assert.equal(JSON.parse(backup).encryptedCatalog, sourceDocument.encryptedCatalog);
      record("reload", {
        freshProcess: mode === "reload",
        matches: true,
        safeStorageDecryptMatches: true,
        encryptedEnvelope: document.version === 1 && typeof document.encryptedCatalog === "string",
        backupCount: backups().length,
        backupCiphertextUnchanged: true,
        backupFileSha256: hash(backup),
      });
      fs.writeFileSync(
        path.join(output, `${mode}-result.json`),
        JSON.stringify({ passed: true, steps }, null, 2),
      );
      app.exit(0);
    } catch (error) {
      console.error(error);
      fs.writeFileSync(
        path.join(output, `${mode}-result.json`),
        JSON.stringify({ passed: false, steps, error: String(error) }, null, 2),
      );
      app.exit(1);
    }
  });
});
require(process.env.CATALOG_FIXTURE_MAIN);
