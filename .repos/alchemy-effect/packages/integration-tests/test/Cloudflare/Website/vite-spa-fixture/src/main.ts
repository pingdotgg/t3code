// The entire fixture: a single client module referenced by index.html.
// There is no vite.config.ts and no plugins, so the Cloudflare Vite plugin
// resolves the project as `appType: "spa"` with no worker entry — which means
// it declares no `builder.buildApp`. On Vite 8 that is the code path where a
// post-order `buildApp` hook fires before the client environment builds, so
// this fixture is the minimal reproduction for issue #792.
const el = document.getElementById("app");
if (el) {
  el.textContent = `${el.textContent} (hydrated)`;
}
