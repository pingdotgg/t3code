{
  description = "T3 Code";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, self }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      packages.${system} = rec {
        t3code = pkgs.callPackage ./nix/package.nix { src = self; };
        default = t3code;
      };

      formatter.${system} = pkgs.nixfmt;
    };
}
