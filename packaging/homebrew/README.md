# Homebrew Cask Packaging

This directory contains a Homebrew Cask definition for installing T3 Code on macOS.

## Current status

The cask in `Casks/t3code.rb` is a ready-to-use template. To make `brew install --cask t3code`
work, the cask must be submitted to a Homebrew tap or to [homebrew-cask](https://github.com/Homebrew/homebrew-cask).

## Installing from this repo (local tap)

You can test the cask locally before submitting:

```bash
brew install --cask ./packaging/homebrew/Casks/t3code.rb
```

Or set up a custom tap:

```bash
# In a repo named "homebrew-t3code" with Casks/t3code.rb:
brew tap <your-org>/t3code
brew install --cask t3code
```

## Submitting to homebrew-cask

See the [Homebrew Cask contribution guide](https://github.com/Homebrew/homebrew-cask/blob/master/CONTRIBUTING.md).

Key requirements:
- The app must have a stable release
- The cask must pass `brew audit --cask t3code`
- The app must be signed or notarized

## Updating for a new release

1. Update `version` in `Casks/t3code.rb`
2. Download both DMGs and compute their SHA256:
   ```bash
   curl -sL "https://github.com/pingdotgg/t3code/releases/download/v<VERSION>/T3-Code-<VERSION>-arm64.dmg" | shasum -a 256
   curl -sL "https://github.com/pingdotgg/t3code/releases/download/v<VERSION>/T3-Code-<VERSION>-x64.dmg" | shasum -a 256
   ```
3. Update both `sha256` values in the cask

## Prerequisites

Users must install and authorize [Codex CLI](https://github.com/openai/codex)
separately. T3 Code is a GUI frontend — it does not bundle Codex.
