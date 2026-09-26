# Installed package asset example

This independently packaged format-4 plugin loads its declared WebAssembly file with the public ClientHost.readAsset method. Its own sidebar view runs the module and displays its return value, 42. It imports no private application component, URL helper, filesystem service, or host credential.

Install this directory through an environment that advertises package format 4. Open Extensions, then Package asset demo, and choose Load package asset. No terminal or workspace grants are needed for the package's own immutable data.

The request belongs to the loaded installation and is cancelled when its view or installation is disposed. A changed manifest or asset digest creates a new installation hash. Disable, update and removal reject stale results. Returned bytes are ordinary data: a plugin that creates object URLs from them owns their cleanup.

This is an asset-loading example. It is not a terminal implementation and proves no terminal, mobile, relay/tunnel or V2 parity. See the host's verification evidence before relying on format-4 support.
