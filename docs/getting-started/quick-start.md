# Quick start

```bash
# Install dependencies and build the backend sidecar
vp install
vp run build:server

# Run the native macOS app from SwiftPM
swift run --package-path apps/mac SergeCodeMac

# Or build the backend and assemble a local .app bundle in one step
vp run build:local
open apps/mac/dist/SurgeCode.app

# Run a standalone backend for mobile pairing
vp run dev:server
```
