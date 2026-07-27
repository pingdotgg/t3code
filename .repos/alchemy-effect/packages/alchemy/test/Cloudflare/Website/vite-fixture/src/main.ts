// Minimal client entry. The cloudflare-vite-plugin handles the worker
// runtime separately; this file just satisfies the `index.html` script tag
// reference so Vite emits a real client bundle.
//
// `import.meta.env.VITE_TEST_MARKER` is referenced here so the
// "Vite: env props" test can verify `Cloudflare.Website.Vite({ env })` actually
// reaches the client bundle. Vite inlines the value via the `define`
// hook at build time; the integration test fetches the deployed JS
// asset and asserts the value is present.
const marker = (import.meta.env as { VITE_TEST_MARKER?: string })
  .VITE_TEST_MARKER;
const el = document.getElementById("app");
if (el) {
  el.textContent = `${el.textContent} (hydrated, marker=${marker ?? ""})`;
}
