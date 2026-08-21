# Oh My Pi

Oh My Pi (OMP) is an agent runtime that supports multiple model providers through one CLI. T3
Code includes OMP as a built-in provider, but it is off by default.

## Install OMP

Install OMP on the machine that runs the T3 Code server:

```bash
curl -fsSL https://omp.sh/install | sh
```

You can also install it with Homebrew:

```bash
brew install can1357/tap/omp
```

Run the setup flow and choose a default model:

```bash
omp setup
```

## Enable OMP in T3 Code

Open **Settings** and enable the Oh My Pi provider. The default binary path is `omp`. Set a
different binary path when OMP is installed outside your `PATH`. Use **Launch arguments** only
when your OMP setup needs extra command-line options.

Run `omp models` to check that OMP can discover models before starting a T3 Code thread.

T3 Code uses each model's OMP provider ID in the model picker. This identifies models that have
the same display name, such as models available through both Moonshot and OpenRouter.

Periodic health checks do not load OMP extensions. If an extension registers a model, add its full
OMP selector under **Custom models**. The normal OMP session loads the extension and validates the
selector when the thread starts.

## Permission behavior

T3 Code maps its permission modes to OMP approval modes:

- **Supervised** and **Auto** use OMP's `always-ask` mode.
- **Auto-accept edits** uses OMP's `write` mode.
- **Full access** uses OMP's `yolo` mode.

T3 Code controls this mapping for every OMP session. Approval flags in **Launch arguments** cannot
override the selected T3 Code permission mode.

OMP 17.4.0 can show a second approval form for a supervised shell command or destructive edit. OMP
currently applies its ACP client gate and its native approval gate to those calls.

OMP does not yet expose the provider-history controls that T3 Code needs for checkpoint rollback or
the T3 Code Plan mode lifecycle. T3 Code hides Plan mode for OMP and reports checkpoint rollback as
unsupported. Follow-up messages wait for the active OMP turn to finish, then start a new turn.
