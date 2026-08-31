# Hermes Agent

The Hermes provider is experimental. T3 Code starts `hermes acp` on the connected environment and
uses that environment's Hermes configuration, credentials, tools, and session store.

## Set up Hermes

Install and configure Hermes Agent on the environment that runs the T3 server. Confirm that this
command starts without a setup error:

```bash
hermes acp --check
```

Open **Settings > Providers**, add or enable Hermes, and leave **Binary path** as `hermes`. Set an
absolute binary path when `hermes` is not on the T3 server's `PATH`.

The provider verifies the ACP connection when you start a session. If startup fails, run
`hermes acp --check` in the same environment and fix the reported Hermes setup or authentication
problem.

## Current limits

T3 Code uses the model and provider configured by Hermes Agent. The T3 model picker does not select
a Hermes model. Hermes also cannot generate thread titles, branch names, commit messages, or pull
request text through T3 Code yet.
