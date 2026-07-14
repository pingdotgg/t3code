# Quick start

```bash
# Install dependencies and build the backend sidecar
vp install
vp run build:server

# Run the native macOS app from SwiftPM
swift run --package-path apps/mac SergeCodeMac

# Or assemble a local .app bundle
vp run package:mac
open apps/mac/dist/SurgeCode.app

# Run a standalone backend for mobile pairing
vp run dev:server
```
