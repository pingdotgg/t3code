// Proves the client bundle executed (the built site loads this module).
document.querySelector("#app")?.setAttribute("data-ready", "true");
// Proves the site's `env` reached the build (Vite inlines `VITE_*` vars).
document
  .querySelector("#app")
  ?.setAttribute("data-site-env", (import.meta as any).env?.VITE_SITE_ENV ?? "unset");

export const marker = "VITE_AWS_MODULE_MARKER";
