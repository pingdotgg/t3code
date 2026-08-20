# runtime status example plugin

this is the minimal trusted local plugin package used to prove the package lifecycle. plugins run in the server process with the server's full permissions, so only install code you trust.

copy this directory to:

```text
~/.t3/userdata/plugins/com.t3code.runtime-status-example
```

t3 code discovers the package without a rebuild. use `pluginPackages.status` to inspect it and `pluginPackages.enable` with the manifest id to enable it for that environment. `pluginPackages.reload` re-evaluates the entrypoint, and `pluginPackages.disable` removes its contributions. once enabled, `example.runtime-status` appears on web, desktop, and mobile command surfaces.

local packages run in the server process and are fully trusted. marketplace distribution, signing, sandboxing, and renderer code are not part of this mvp.
