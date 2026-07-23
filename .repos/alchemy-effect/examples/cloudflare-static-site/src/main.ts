const app = document.getElementById("app");
if (app) {
  const now = new Date();
  app.innerHTML = `Built at: ${now.toISOString()}`;
}
