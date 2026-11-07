import { chmod, readFile, writeFile } from "node:fs/promises";
const url = process.env.T3_PEBBLE_URL;
if (!url) throw new Error("Set T3_PEBBLE_URL to the HTTPS URL of the Pebble companion");
if (new URL(url).protocol !== "https:") throw new Error("T3_PEBBLE_URL must use HTTPS");
await writeFile("src/pkjs/config.json", JSON.stringify({ url: url.replace(/\/$/, ""), token: process.env.T3_PEBBLE_TOKEN ?? "" }), { mode: 0o600 });
await chmod("src/pkjs/config.json", 0o600);

const manifest = JSON.parse(await readFile("package.template.json", "utf8"));
manifest.pebble.usesPermissions = ["LocalNetwork", { name: "Internet", parameters: { domains: [new URL(url).hostname] } }];
await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
