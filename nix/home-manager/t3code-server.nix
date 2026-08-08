{self}: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.services.t3code;
  serverCommand = pkgs.writeShellScript "t3code-headless-server" ''
    set -eu

    repository_root=${lib.escapeShellArg cfg.repositoryRoot}
    if [ ! -d "$repository_root" ]; then
      echo "T3 Code repository root does not exist: $repository_root" >&2
      exit 69
    fi

    export PATH=${lib.escapeShellArg "${lib.makeBinPath ([cfg.package] ++ cfg.extraPackages)}:/run/current-system/sw/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"}
    export T3CODE_HOME=${lib.escapeShellArg cfg.dataDirectory}

    cd "$repository_root"
    server_args=(
      serve
      --host ${lib.escapeShellArg cfg.host}
      --port ${toString cfg.port}
      ${lib.optionalString cfg.tailscaleServe.enable ''
      --tailscale-serve
      --tailscale-serve-port ${toString cfg.tailscaleServe.port}
    ''}
    )
    exec ${lib.getExe' cfg.package "t3"} "''${server_args[@]}"
  '';
in {
  options.services.t3code = {
    enable = lib.mkEnableOption "a persistent T3 Code headless server";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.t3code;
      defaultText = lib.literalExpression "inputs.t3code.packages.\${pkgs.system}.t3code";
      description = "T3 Code package used by the service.";
    };

    repositoryRoot = lib.mkOption {
      type = lib.types.str;
      default = config.home.homeDirectory;
      description = "Repository opened by the persistent T3 Code server.";
    };

    dataDirectory = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/.t3";
      description = "Persistent T3 Code state directory.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address on which the local T3 Code server listens.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3774;
      description = "Port on which the local T3 Code server listens.";
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        bashInteractive
        claude-code
        codex
        coreutils
        findutils
        gh
        git
        gnugrep
        gnused
        nix
        nodejs
        openssh
        ripgrep
        tailscale
        zsh
      ];
      description = "Additional packages available to the server and its provider processes.";
    };

    systemdTarget = lib.mkOption {
      type = lib.types.str;
      default = "graphical-session.target";
      description = "User systemd target that starts the service.";
    };

    tailscaleServe = {
      enable = lib.mkEnableOption "Tailscale Serve publication" // {default = true;};

      port = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Tailnet-only HTTPS port exposed by Tailscale Serve.";
      };
    };
  };

  config = lib.mkIf cfg.enable (lib.mkMerge [
    {
      home.packages = [cfg.package];
    }

    (lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
      systemd.user.services.t3code-headless = {
        Unit = {
          Description = "T3 Code headless server";
          Documentation = "https://github.com/pingdotgg/t3code/blob/main/REMOTE.md";
          After = [cfg.systemdTarget];
          ConditionPathIsDirectory = cfg.repositoryRoot;
          StartLimitIntervalSec = 300;
          StartLimitBurst = 5;
        };

        Service = {
          Type = "simple";
          ExecStart = "${serverCommand}";
          Restart = "always";
          RestartSec = 5;
          TimeoutStopSec = 15;
          UMask = "0077";
        };

        # Deliberately omit PartOf so the backend survives graphical logout.
        Install.WantedBy = [cfg.systemdTarget];
      };
    })

    (lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
      launchd.agents.t3code-headless = {
        enable = true;
        config = {
          ProgramArguments = ["${serverCommand}"];
          KeepAlive = true;
          ProcessType = "Interactive";
          RunAtLoad = true;
          ThrottleInterval = 5;
          StandardOutPath = "${config.home.homeDirectory}/Library/Logs/t3code-headless.log";
          StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/t3code-headless.err.log";
        };
      };
    })
  ]);
}
