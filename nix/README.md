# Nix

The flake exports the T3 Code package for `x86_64-linux`.

## NixOS user service

Add T3 Code to your flake inputs:

```nix
inputs.t3code.url = "github:tarik02-org/t3code";
```

Then add the package and user service to your NixOS configuration:

```nix
{ inputs, pkgs, ... }:

let
  t3code = inputs.t3code.packages.${pkgs.stdenv.hostPlatform.system}.default;
in
{
  environment.systemPackages = [ t3code ];

  systemd.user.services.t3code = {
    description = "T3 Code server";
    wantedBy = [ "default.target" ];
    wants = [ "network-online.target" ];
    after = [ "network-online.target" ];

    serviceConfig = {
      Type = "simple";
      ExecStart = "${t3code}/bin/t3 serve --host 0.0.0.0 --port 3773";
      WorkingDirectory = "%h";
      Environment = [ "T3CODE_NO_BROWSER=1" ];
      Restart = "on-failure";
      RestartSec = "5s";
      OOMPolicy = "continue";
    };
  };
}
```
