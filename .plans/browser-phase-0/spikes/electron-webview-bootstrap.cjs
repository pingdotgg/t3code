const { app } = require("electron");

const portArgument = process.argv.find((value) => value.startsWith("--port="));
if (portArgument) {
  app.commandLine.appendSwitch("remote-debugging-address", "127.0.0.1");
  app.commandLine.appendSwitch("remote-debugging-port", portArgument.slice("--port=".length));
}
app.commandLine.appendSwitch("disable-background-timer-throttling");

app
  .whenReady()
  .then(() => import("./electron-webview-host.mjs"))
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
