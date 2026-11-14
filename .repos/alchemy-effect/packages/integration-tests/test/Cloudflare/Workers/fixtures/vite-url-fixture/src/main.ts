// Minimal client entry. `import.meta.env.VITE_PUBLIC_URL` is referenced so
// the client bundle also receives the inlined URL (Vite `define` at build
// time); the test asserts the server-side inline via `/self-url`.
const url = (import.meta.env as { VITE_PUBLIC_URL?: string }).VITE_PUBLIC_URL;
const el = document.getElementById("app");
if (el) {
  el.textContent = `public url: ${url ?? ""}`;
}
