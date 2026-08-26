// Injected at document creation into every page the shell hosts. Defines
// `window.t3Shell` synchronously so the web app can detect the shell at module
// load (like `desktopBridge`); the channel itself connects once qwebchannel.js
// (injected alongside, order not guaranteed) has defined QWebChannel.
(() => {
  if (window.t3Shell !== undefined) {
    return;
  }
  const transport = window.qt && window.qt.webChannelTransport;
  if (!transport) {
    return;
  }
  const ready = new Promise((resolve, reject) => {
    let attempts = 0;
    const connect = () => {
      if (typeof window.QWebChannel !== "function") {
        attempts += 1;
        if (attempts > 200) {
          reject(new Error("qwebchannel.js never loaded"));
          return;
        }
        setTimeout(connect, 10);
        return;
      }
      void new window.QWebChannel(transport, (channel) => {
        const shell = channel.objects.shell;
        if (!shell) {
          reject(new Error("t3 shell object missing on the web channel"));
          return;
        }
        resolve(shell);
      });
    };
    connect();
  });
  window.t3Shell = Object.freeze({
    protocolVersion: 1,
    ready,
    publish: (key, value) => ready.then((shell) => shell.publish(key, value)),
    onAction: (listener) =>
      ready.then((shell) => {
        shell.actionRequested.connect(listener);
        return () => shell.actionRequested.disconnect(listener);
      }),
  });
})();
