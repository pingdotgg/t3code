// Injected into every page the shell hosts, after qwebchannel.js. Exposes the
// Qt side to the web app as `window.t3Shell`; the page decides what to publish.
(() => {
  if (window.t3Shell !== undefined) {
    return;
  }
  const transport = window.qt && window.qt.webChannelTransport;
  if (!transport || typeof window.QWebChannel !== "function") {
    return;
  }
  const ready = new Promise((resolve, reject) => {
    try {
      void new window.QWebChannel(transport, (channel) => {
        const shell = channel.objects.shell;
        if (!shell) {
          reject(new Error("t3 shell object missing on the web channel"));
          return;
        }
        resolve(shell);
      });
    } catch (error) {
      reject(error);
    }
  });
  window.t3Shell = Object.freeze({
    ready,
    publish: (key, value) => ready.then((shell) => shell.publish(key, value)),
    onAction: (listener) => ready.then((shell) => shell.actionRequested.connect(listener)),
  });
})();
