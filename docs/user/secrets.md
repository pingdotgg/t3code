# Secrets

T3 Code can read credentials from a secret provider, so the credential stays in your password
manager and T3 Code saves only a reference to it. Agents can also ask you for a secret in a
private card instead of in the chat.

The Secrets settings page is in preview and is not in every build yet. Secret requests from agents
work everywhere.

## Secret providers

1Password is the supported provider. T3 Code reads secrets with the
[1Password CLI](https://developer.1password.com/docs/cli/) (`op`), so `op` must be installed and
signed in on the machine that runs the T3 Code server. When you use T3 Code on another machine or
from your phone, that is the remote machine, not the device in front of you.

To add one, open **Settings → Secrets**, select **Add provider**, and enter a name and the
1Password account: the shorthand, sign-in address (without `https://`), or ID that
`op account list` shows. Secret providers belong to the environment you are connected to. Each
environment keeps its own list.

## Use a secret reference

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.

T3 Code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. T3 Code never replaces a saved credential it cannot read with another
login.

## Remove a secret provider

When you remove a secret provider in **Settings → Secrets**, T3 Code lists the fields that read
from it. Removing it clears those fields, so set them again before you need them. The secrets in
1Password are not touched.

## When an agent asks for a secret

An agent that needs a token or password shows a secret request card in the thread instead of asking
you to paste it into the chat. Type or paste the value and select **Save securely**, or select
**Decline**. You can answer from web, desktop, or mobile.

If the environment has a secret provider, the card also lets you pick it and enter a reference
instead of the value. T3 Code reads the secret once, when you answer. If 1Password is locked, the
card says so and the request stays open: unlock it and try again, or enter the value.

The value never appears in the conversation. Most requests keep it from the agent too: T3 Code
passes it to the tool that needs it. When an agent has to run a command with the value, the card
says so instead: the value goes into a private file that the agent's commands can read for about 24
hours.

## When an agent sends you a secret

An agent that creates or finds a credential for you, such as a new database password, can send it as
a private card instead of printing it in the chat. Sending currently requires a POSIX environment
host (Linux or macOS); Windows hosts are not supported yet. The card shows only its label until you
select **Reveal**. **Copy** puts the value on your clipboard without showing it. If your browser blocks
Copy, reveal the value and copy the text yourself. **Hide** clears it from the screen, as does leaving
the thread, switching tabs, minimizing the desktop window, or backgrounding the mobile app.

You can reveal or copy it from web, desktop, or mobile for 24 hours, and only from the original
thread with a connection that can operate it. Forked threads and guest shares show the card without
the value. **Delete** removes T3 Code's copy early. It cannot change or revoke the credential
itself, and anything you already copied stays where you pasted it.
