# Plugin settings and storage

A trusted local plugin can declare settings that you fill in, including
secrets such as API tokens, and keep a small amount of its own data between
runs. Forms for filling in settings arrive in the clients later; until then,
settings are saved from an administrative connection with the
`plugins.settings.update` request.

## Declaring settings

In the plugin's `t3-plugin.json`, add `"settings"` to `capabilities`, set
`"proposedApi": true`, and list up to 32 fields in `settings`. Each field has
a `type` (`text`, `secret`, `boolean`, `number` or `select`), a unique `key`
and a `label`, and may have a `description`. Every type except `secret` can
have a `default`; `number` can set `min`, `max` and `integer`, and `select`
lists its `options`:

```json
{
  "capabilities": ["settings"],
  "proposedApi": true,
  "settings": [
    { "type": "text", "key": "apiUrl", "label": "API URL", "default": "https://api.example.com" },
    { "type": "secret", "key": "token", "label": "API token" }
  ]
}
```

A manifest whose settings T3 Code cannot honor, such as a default outside its
own bounds, is refused when the plugin is added.

## Reading settings

`context.proposed.settings.get(key)` returns the saved value if it still fits
the field, else the field's default, else `undefined`. A secret returns its saved text. Asking for
a key the manifest does not declare rejects.

Secrets are write-only for clients: a client learns only whether a secret is
saved, never its value. T3 Code stores each secret as a plain-text file,
readable only by your OS user, in the server's secrets directory. It is not
encrypted.

## Plugin storage

`context.proposed.storage` keeps JSON values under string keys with `get`,
`set`, `delete` and `keys`. Each installation has its own storage, limited to
keys of 1 to 128 characters, values up to 64 KiB of JSON, 256 keys and 1 MiB
in total. A write past a limit rejects.

## How long values last

Settings, secrets and storage belong to the installation. They survive
disabling and enabling it again, server restarts and updates to the plugin's
files. When a new version stops declaring a field, or switches it between
secret and non-secret, its saved value is deleted at the next save. A saved
value that no longer fits a changed field is kept, but reads fall back to the
default until it fits again. Removing the plugin deletes everything saved for
it.
