// Proves the client bundle executed (the built site loads this module).
document.querySelector("#app")?.setAttribute("data-ready", "true");

export const marker = "VITE_AWS_MODULE_MARKER";
