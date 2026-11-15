# Continuum IDE on macOS

There is no prebuilt macOS download yet. Upstream T3 Code's macOS support is kept, so you can build
Continuum IDE yourself on a Mac with Apple silicon or Intel:

1. Install Xcode command line tools: `xcode-select --install`.
2. Install Rust (`curl https://sh.rustup.rs -sSf | sh`) and [Vite+](https://viteplus.dev/guide/).
3. Clone and build:

```bash
git clone https://github.com/SwashX-dev/continuum-ide.git && cd continuum-ide && vp i
```

```bash
vp run dist:desktop:dmg
```

The DMG appears in `release/`. It is not signed or notarized, so macOS Gatekeeper blocks the first
launch: open **System Settings → Privacy & Security** and choose **Open Anyway**. Window
transparency works instantly on macOS.
