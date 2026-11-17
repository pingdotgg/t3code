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

A desktop sign-in asks for approval on that machine, which a remote user cannot answer. On a remote
or headless server, sign `op` in with a [service account](./secrets-1password-service-account.md) or a
[Connect server](./secrets-1password-connect.md) instead.

To add one, open **Settings → Secrets**, select **Add provider**, and enter a name and the
1Password account: the shorthand, sign-in address (without `https://`), or ID that
`op account list` shows. Secret providers belong to the environment you are connected to. Each
environment keeps its own list.

## Use a secret reference

Credential fields in Settings, such as provider environment variables and credentials, source
control tokens, usage limit keys, and device host tokens, show a source picker next to the field.
Pick **Value** to save the credential itself, or pick a secret provider and enter a reference such
as `op://vault/item/field`. Copy the reference from 1Password with **Copy Secret Reference**.
Select the check button next to a reference to read it now. If it reads, providers that use it
start using the new value.

T3 Code reads the secret when it needs it, for example when a provider starts. Change the
credential in 1Password and refresh to use the new value.

## When a secret cannot be read

If 1Password is locked or signed out, the provider or feature that needs the secret shows an error
naming the secret provider. Unlock 1Password on the server's machine, then select **Refresh** in
**Settings → Providers**. T3 Code never replaces a saved credential it cannot read with another
login.

## Fill logins in the browser

T3 Code can fill Login items from one 1Password vault into pages in the in-app browser, for you and
for agents. Agents see each login's title, URLs, and which fields it has. The fill tools never
return the username, password, or one-time code, and snapshots hide them. A page can still show
your username on its own, for example on a sign-in step, and an agent that runs scripts in the page
can read any field. A password fills only into a password field, and a login fills only on a page
whose origin exactly matches one of its URLs: https, or http on `localhost`. Fields in a frame from
another origin are never filled, and a fill never submits the form.

To turn it on, add a secret provider, then in **Settings → Secrets** turn on **Fill browser logins**
and choose the provider and vault. Select **Check** to see how many logins the vault holds. Agents
can use every login in the vault, so use one that holds only the logins you want them to use. With
1Password Connect, `op` cannot list vaults, so type the vault's name.

On a page that can take a login, the browser toolbar shows a key. Select it, or press `Mod+Alt+L`
with the browser focused, then **Fill login** to fill the username and password, or **Fill code** to
fill the one-time code. While an agent controls the tab, take control first. The fill runs on the
server's machine, where 1Password is, so it works for tabs on remote environments too.

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
