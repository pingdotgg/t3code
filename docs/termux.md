# Termux / Android

T3 Code can run on Android through Termux as the web server plus browser UI. The desktop app is not used on Android.

The main Android-specific issue is native modules. `node-pty` and `msgpackr-extract` do not publish Android ARM64 prebuilds, so npm must build them locally and pass Termux's NDK sysroot path through to `node-gyp`.

## Requirements

- Android ARM64 device.
- Termux from F-Droid or the official Termux GitHub releases.
- At least 700 MB free for the compiler toolchain and npm dependencies.
- Node.js 22.16+, 23.11+, or 24.10+.
- An authenticated provider. Codex is the recommended provider on Termux.

## Quick Install

From Termux:

```sh
curl -fsSL https://raw.githubusercontent.com/timm-u/t3code/main/scripts/install-termux.sh | sh
```

The installer:

- installs Termux packages needed to build native npm modules;
- installs the Termux Codex CLI fork when `codex` is missing;
- creates `~/t3code-termux`;
- installs `t3` with Android native build settings;
- adds `npm start`, `npm run serve`, and `npm run rebuild-native` helper scripts.

Start T3 Code:

```sh
cd ~/t3code-termux
npm start
```

Open the pairing URL printed by the server in Android browser. It looks like:

```text
http://127.0.0.1:8787/pair#token=...
```

## Codex CLI For Termux

The official Codex CLI binaries are not Android/Termux binaries. Use the Termux-focused fork:

```sh
pkg install -y nodejs-lts
npm install -g @mmmbuto/codex-cli-termux@latest
codex --version
codex login
```

Project: <https://github.com/DioNanos/codex-termux>

After login, T3 Code should detect `codex` on `PATH`.

## Manual Install

Use this when you want to see every step or adapt the install directory.

```sh
pkg update -y
pkg install -y nodejs-lts git clang make python pkg-config

npm install -g @mmmbuto/codex-cli-termux@latest
codex login

mkdir -p ~/t3code-termux
cd ~/t3code-termux
npm init -y

npm_config_android_ndk_path="$PREFIX" npm install t3@latest
npm pkg set "scripts.start=t3 start --host 127.0.0.1 --port 8787 --no-browser $HOME"
npm start
```

The `npm_config_android_ndk_path="$PREFIX"` prefix is the key Android compatibility setting. Without it, npm may fail with:

```text
gyp: Undefined variable android_ndk_path in binding.gyp while trying to load binding.gyp
```

## Useful Variants

Install to a custom directory:

```sh
T3CODE_TERMUX_DIR="$HOME/apps/t3code" sh scripts/install-termux.sh
```

Use another port:

```sh
T3CODE_PORT=9797 sh scripts/install-termux.sh
```

Bind to all interfaces so another device can connect:

```sh
T3CODE_HOST=0.0.0.0 sh scripts/install-termux.sh
```

Only bind to `0.0.0.0` on a trusted network. Use the pairing URL and avoid exposing the port to the public internet.

Skip Codex installation:

```sh
T3CODE_INSTALL_CODEX=0 sh scripts/install-termux.sh
```

## Troubleshooting

### Rebuild Native Modules

If npm dependencies are reinstalled or Node.js is upgraded:

```sh
cd ~/t3code-termux
npm run rebuild-native
```

### `node-pty` Has No Android Prebuild

This is expected. The installer builds it locally with Termux's compiler.

### Browser Did Not Open

Use the printed pairing URL manually. On the same phone, `127.0.0.1` points at Termux.

### Codex Is Not Detected

Check:

```sh
command -v codex
codex --version
codex login
```

If `codex` exists but T3 Code still cannot find it, start T3 Code from the same Termux shell where `codex` is on `PATH`.
