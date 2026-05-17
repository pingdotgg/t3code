
# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon).

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

#### NixOS (Flakes)

```nix
# /path/to/your/flake.nix
{
  inputs = {
    # This flake is pinned to nixpkgs stable
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.05";

    t3code-flake.url = "github:pingdotgg/t3code";
    t3code-flake.inputs.nixpkgs.follows = "nixpkgs";

    # Optional: pin to a specific release
    # t3code-flake.releaseTag = "v0.0.23";
  };
}
```

```nix
# /path/to/your/configuration.nix
{
  nix.settings.experimental-features = [ "nix-command" "flakes" ];
  environment.systemPackages = [
    pkgs.appimage-run
    inputs.t3code-flake.packages.${system}.default
  ];
}
```

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
