# Isolate Pi from discovered user extensions

Pi runtime instances will start with Pi's `--no-extensions` flag so arbitrary user extension hooks cannot alter T3 Code tool execution. Users may explicitly load a trusted extension with Pi's `--extension <path>` launch argument; T3 Code will render compatible RPC extension dialogs from those explicit extensions where possible and clearly report unsupported custom extension UI as requiring Pi's terminal interface.
