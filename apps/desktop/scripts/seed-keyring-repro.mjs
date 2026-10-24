// Run against the BASE desktop's main inspector with an unlocked disposable keyring.
// Start a disposable built T3 server, then issue its token with:
// node apps/server/dist/bin.mjs auth session issue --base-dir /tmp/target --token-only > /tmp/token
// node apps/desktop/scripts/seed-keyring-repro.mjs /tmp/desktop /tmp/target /tmp/token catalog
// Pass `legacy` instead of `catalog` to exercise bearer, SSH, and token-absent migration.
// Launch Electron with --inspect=9339 and isolated T3CODE_HOME/XDG_CONFIG_HOME/XDG_DATA_HOME.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const [desktopHome, targetHome, tokenFile, mode = "catalog"] = process.argv.slice(2);
if (!desktopHome || !targetHome || !tokenFile || !["catalog", "legacy"].includes(mode)) {
  throw new Error("Expected: desktop-home target-home token-file [catalog|legacy]");
}
const targetId = (
  await NodeFSP.readFile(NodePath.join(targetHome, "userdata/environment-id"), "utf8")
).trim();
const token = (await NodeFSP.readFile(tokenFile, "utf8")).trim().split("\n").at(-1);
const home = NodePath.resolve(desktopHome);
const targets = await (await fetch("http://127.0.0.1:9339/json/list")).json();
const mainTarget = targets.find((target) => target.type === "node" && target.webSocketDebuggerUrl);
if (!mainTarget) throw new Error("No Node main-process inspector target on port 9339");
const ws = new WebSocket(mainTarget.webSocketDebuggerUrl);
await new Promise((accept, reject) => {
  ws.addEventListener("open", accept, { once: true });
  ws.addEventListener("error", reject, { once: true });
});
const response = new Promise((accept, reject) => {
  ws.addEventListener("message", ({ data }) => {
    const result = JSON.parse(data);
    if (result.id !== 1) return;
    if (result.error || result.result?.exceptionDetails)
      reject(new Error("Native fixture seeding failed"));
    else accept(result.result.result.value);
  });
});
const expression = `(() => {
  const fs = process.getBuiltinModule('fs');
  const path = process.getBuiltinModule('path');
  const os = process.getBuiltinModule('os');
  const home = ${JSON.stringify(home)};
  // Compare real paths so a symlink alias of a live directory cannot pass; a missing
  // destination resolves through its nearest existing ancestor.
  const canonical = (value) => {
    const rest = [];
    for (let dir = path.resolve(value); ; dir = path.dirname(dir)) {
      try {
        return path.join(fs.realpathSync.native(dir), ...rest);
      } catch (error) {
        if (error.code !== 'ENOENT' || fs.lstatSync(dir, { throwIfNoEntry: false }) || dir === path.dirname(dir)) throw error;
        rest.unshift(path.basename(dir));
      }
    }
  };
  // Desktop config trims XDG values and falls back to the real defaults when blank.
  const isolated = (name, fallback) => {
    const value = process.env[name] || '';
    return value === value.trim() && path.isAbsolute(value) && canonical(value) !== canonical(path.join(os.homedir(), fallback));
  };
  const t3Home = process.env.T3CODE_HOME || '';
  if (!t3Home || canonical(t3Home) !== canonical(home) || canonical(home) === canonical(path.join(os.homedir(), '.t3')) || !isolated('XDG_CONFIG_HOME', '.config') || !isolated('XDG_DATA_HOME', '.local/share')) {
    throw new Error('Requires matching isolated T3CODE_HOME and isolated XDG directories');
  }
  const E = process.getBuiltinModule('module').createRequire(process.cwd() + '/fixture.cjs')('electron');
  if (!E.safeStorage.isEncryptionAvailable()) throw new Error('Unlock disposable keyring first');
  const id = ${JSON.stringify(targetId)};
  const token = ${JSON.stringify(token)};
  const state = path.join(home, 'userdata');
  fs.mkdirSync(state, { recursive: true });
  const encrypt = value => E.safeStorage.encryptString(value).toString('base64');
  const catalogPath = path.join(state, 'connection-catalog.json');
  const registryPath = path.join(state, 'saved-environments.json');
  if (fs.existsSync(catalogPath) || fs.existsSync(registryPath)) throw new Error('Use a pristine fixture directory; refusing overwrite');
  if (${JSON.stringify(mode)} === 'catalog') {
    const common = {environmentId:id,label:'Sync fixture target',connectionId:'issue9239-bearer'};
    const catalog = {schemaVersion:1,targets:[{_tag:'BearerConnectionTarget',...common}],profiles:[{_tag:'BearerConnectionProfile',...common,httpBaseUrl:'http://127.0.0.1:4788',wsBaseUrl:'ws://127.0.0.1:4788'}],credentials:[{connectionId:common.connectionId,credential:{_tag:'BearerConnectionCredential',token}}],remoteDpopTokens:[],disabledEnvironmentIds:[]};
    fs.writeFileSync(catalogPath,JSON.stringify({version:1,encryptedCatalog:encrypt(JSON.stringify(catalog))}));
  } else {
    const common = {httpBaseUrl:'http://127.0.0.1:4788',wsBaseUrl:'ws://127.0.0.1:4788',createdAt:'2026-10-22T00:00:00.000Z',lastConnectedAt:null};
    fs.writeFileSync(registryPath,JSON.stringify({version:1,records:[{...common,environmentId:id,label:'Legacy bearer fixture',encryptedBearerToken:encrypt(token)},{...common,environmentId:'issue9239-no-token',label:'Legacy no-token fixture'},{...common,environmentId:'issue9239-ssh',label:'Legacy SSH fixture',desktopSsh:{alias:'fixture.invalid',hostname:'fixture.invalid',username:null,port:null}}]}));
  }
  return {mode:${JSON.stringify(mode)},backend:E.safeStorage.getSelectedStorageBackend(),syncFixtureWritten:true};
})()`;
ws.send(
  JSON.stringify({
    id: 1,
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true },
  }),
);
try {
  console.log(JSON.stringify(await response));
} finally {
  ws.close();
}
