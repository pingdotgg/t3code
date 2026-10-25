# Improving this Agent

This Agent is made from the definition in `agents/dev/` of `martinothamar/t3code`: its Dockerfile
and `rootfs/`, `agent.yaml` and its variants, these instructions, `skills/` and `home/`. The
`agent-definition` skill applies to it, including bringing it up to date with a later agentctl.

Change it on a branch of the fork, like any other change, and try it in a nested Agent first, as
that skill and the `agentctl` skill describe: `nested` runs the published image, and
`nested-build` builds the image from the checkout, which a change to the Dockerfile or `rootfs/`
needs. The image CI publishes reaches this Agent only when it is created again, which deletes its
disk, so its owner decides when.
