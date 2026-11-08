# SPDX-License-Identifier: MIT
# NixOS module running the flake-built `t3` server as a systemd service.
# Declarative counterpart to the mutable `t3 service install` unit.
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.t3code;
in
{
  options.services.t3code = {
    enable = lib.mkEnableOption "T3 Code server (the bundled `t3` command)";

    package = lib.mkPackageOption pkgs "t3code" { };

    user = lib.mkOption {
      type = lib.types.str;
      description = ''
        User the server runs as. Home-manager-driven agents and provider
        CLIs expect this to be your login user, since agent CLIs, SSH
        keys, and provider credentials live in that user's home.
      '';
    };

    group = lib.mkOption {
      type = lib.types.str;
      default = "users";
      description = "Primary group of the service process.";
    };

    home = lib.mkOption {
      type = lib.types.path;
      description = ''
        T3 home directory (equivalent to `T3CODE_HOME`). Runtime state,
        projects, and threads live under its `userdata` subdirectory.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.path;
      default = "${cfg.home}/userdata";
      defaultText = "\${config.services.t3code.home}/userdata";
      description = "Directory for the service's working state.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 0;
      description = ''
        Port for the HTTP/WebSocket server (`T3CODE_PORT`). `0` picks a
        free port, like `t3` does; the chosen port is logged to the journal.
      '';
    };

    host = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "127.0.0.1";
      description = "Interface to bind (`T3CODE_HOST`). Null keeps the `t3` default.";
    };

    lan = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Accept connections from the local network and tailnet, not only
        this machine (equivalent to `T3CODE_LAN` / `--lan`). Enable `openFirewall`
        to also punch the port through the NixOS firewall.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open `port` in the NixOS firewall. Requires a fixed `port`.";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        T3CODE_LOG_LEVEL = "Info";
      };
      description = ''
        Extra environment variables for the service. See `t3 serve --help`
        and `docs/user/install.md` for the `T3CODE_*` knobs.
      '';
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/t3code.env";
      description = ''
        File with `KEY=VALUE` lines loaded into the service environment,
        for secrets such as provider tokens. Prefer this over `environment`.
      '';
    };

    extraArgs = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      example = [
        "--mode"
        "server"
      ];
      description = "Extra arguments appended to `t3 serve`.";
    };
  };

  config = lib.mkIf cfg.enable (
    let
      serviceArgs =
        [
          "serve"
          "--no-browser"
          "--base-dir"
          cfg.home
        ]
        ++ lib.optionals (cfg.host != null) [
          "--host"
          cfg.host
        ]
        ++ lib.optional (cfg.port != 0) "--port"
        ++ lib.optional (cfg.port != 0) (toString cfg.port)
        ++ lib.optional cfg.lan "--lan"
        ++ cfg.extraArgs;

      serviceEnv =
        {
          T3CODE_NO_BROWSER = "true";
        }
        // lib.optionalAttrs (cfg.port != 0) { T3CODE_PORT = toString cfg.port; }
        // lib.optionalAttrs (cfg.host != null) { T3CODE_HOST = cfg.host; }
        // lib.optionalAttrs cfg.lan { T3CODE_LAN = "true"; }
        // cfg.environment;
    in
    {
      assertions = [
        {
          assertion = cfg.home != toString cfg.dataDir;
          message = "services.t3code.home and services.t3code.dataDir must differ.";
        }
        {
          assertion = !cfg.openFirewall || cfg.port != 0;
          message = "services.t3code.openFirewall needs a fixed services.t3code.port.";
        }
        {
          assertion = builtins.hasAttr cfg.user config.users.users;
          message = "services.t3code.user '${cfg.user}' does not exist.";
        }
      ];

      systemd.services.t3code = {
        description = "T3 Code server";
        wantedBy = [ "multi-user.target" ];
        after = [ "network-online.target" ];
        wants = [ "network-online.target" ];

        environment = serviceEnv;
        serviceConfig = {
          Type = "simple";
          User = cfg.user;
          Group = cfg.group;
          ExecStart = lib.escapeShellArgs ([ "${lib.getExe cfg.package}" ] ++ serviceArgs);
          # NOTE: `t3` resolves agent working directories against the
          # process cwd, so the default start directory is wherever the
          # sysadmin puts the service's work (`dataDir`).
          WorkingDirectory = cfg.dataDir;
          StateDirectory = lib.mkIf (lib.hasPrefix "/var/lib/" cfg.dataDir) (
            lib.removePrefix "/var/lib/" cfg.dataDir
          );
          # `t3 serve` binds, checkpoints, and spawns provider CLIs — it
          # needs a real home to work from.
          ProtectHome = "read-only";
          BindPaths = [ cfg.home ];
          Restart = "on-failure";
          RestartSec = "5s";
          # Agent checkouts and provider caches interoperate better without
          # a private tmp; the service is a long-lived local daemon, and
          # `t3` already sandboxes provider subprocesses itself.
          PrivateTmp = false;
          EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        };

        preStart = ''
          mkdir -p ${lib.escapeShellArg cfg.home} ${lib.escapeShellArg cfg.dataDir}
        '';
      };

      networking.firewall.allowedTCPPorts = lib.mkIf (cfg.openFirewall && cfg.port != 0) [
        cfg.port
      ];
    }
  );
}
