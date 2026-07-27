(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  const { React } = SDK;
  const { useCallback, useEffect, useState } = SDK.hooks;
  const { Badge, Button, Card, CardContent, CardHeader, CardTitle } = SDK.components;

  function T3CodePage() {
    const [status, setStatus] = useState(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState("");

    const refresh = useCallback(async function () {
      try {
        setError("");
        setStatus(await SDK.fetchJSON("/api/plugins/t3code/status"));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      }
    }, []);

    useEffect(function () {
      refresh();
      const timer = window.setInterval(refresh, 10000);
      return function () { window.clearInterval(timer); };
    }, [refresh]);

    async function run(action) {
      setBusy(action);
      setError("");
      try {
        const body = await SDK.fetchJSON("/api/plugins/t3code/" + action, {
          method: "POST",
        });
        setStatus(body.status);
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setBusy("");
      }
    }

    const installed = Boolean(status && status.service_installed);
    const ready = Boolean(status && status.reachable);

    return React.createElement("div", { className: "t3code-plugin" },
      React.createElement(Card, null,
        React.createElement(CardHeader, { className: "t3code-plugin__header" },
          React.createElement("div", null,
            React.createElement(CardTitle, null, "T3 Code"),
            React.createElement("p", { className: "text-sm text-muted-foreground" },
              "A supervised T3 Code server using this Hermes installation over ACP."
            )
          ),
          React.createElement(Badge, { variant: ready ? "default" : "secondary" },
            ready ? "Running" : installed ? "Starting" : "Not installed"
          )
        ),
        React.createElement(CardContent, null,
          error
            ? React.createElement("div", { className: "t3code-plugin__error" }, error)
            : null,
          status
            ? React.createElement("dl", { className: "t3code-plugin__status" },
                React.createElement("dt", null, "Installed product version"),
                React.createElement("dd", null,
                  status.coherent ? status.installed_version : "Needs Update"
                ),
                React.createElement("dt", null, "Address"),
                React.createElement("dd", null, status.url),
                React.createElement("dt", null, "Supervisor"),
                React.createElement("dd", null,
                  status.service_running ? "s6 · up" : status.service_installed ? "s6 · down" : "—"
                ),
                React.createElement("dt", null, "Orphan cleanup"),
                React.createElement("dd", null,
                  status.watchdog_running
                    ? "active · " + status.watch_misses + " misses at " +
                      status.watch_interval_seconds + "s"
                    : "inactive"
                )
              )
            : React.createElement("p", null, "Loading service status…"),
          React.createElement("div", { className: "t3code-plugin__actions" },
            !installed
              ? React.createElement(Button, {
                  disabled: Boolean(busy),
                  onClick: function () { run("install"); }
                }, busy === "install" ? "Installing…" : "Install and start")
              : React.createElement(React.Fragment, null,
                  React.createElement(Button, {
                    disabled: Boolean(busy),
                    onClick: function () { run("update"); }
                  }, busy === "update" ? "Updating…" : "Update"),
                  React.createElement(Button, {
                    variant: "outline",
                    disabled: Boolean(busy),
                    onClick: function () { run("uninstall"); }
                  }, busy === "uninstall" ? "Removing…" : "Remove service")
                ),
            React.createElement(Button, {
              variant: "outline",
              disabled: !ready,
              onClick: function () {
                window.open(status.url, "_blank", "noopener,noreferrer");
              }
            }, "Open T3 Code"),
            React.createElement(Button, {
              variant: "ghost",
              disabled: Boolean(busy),
              onClick: refresh
            }, "Refresh")
          ),
          installed
            ? React.createElement("p", { className: "t3code-plugin__note" },
                "Update advances the T3/Hermes integration and native runtime " +
                "together, activates them, and verifies service health. " +
                "Removing the service keeps the downloaded binary and T3 Code data. " +
                "If Hermes removes the plugin directory directly, the delayed watchdog " +
                "removes both s6 slots."
              )
            : null
        )
      )
    );
  }

  window.__HERMES_PLUGINS__.register("t3code", T3CodePage);
})();
