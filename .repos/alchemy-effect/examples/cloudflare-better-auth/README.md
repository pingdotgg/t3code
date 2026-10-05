# Cloudflare Better Auth

Executable companion to the [six-part Better Auth tutorial](https://alchemy.run/better-auth/tutorial/part-1).

## Run locally

From the repository root:

```sh
pnpm install
cd examples/cloudflare-better-auth
bun run dev
```

Use a [configured Cloudflare profile](https://alchemy.run/cloudflare/setup). Alchemy chooses an available port and prints the URL; the local Worker and D1 run without provisioning cloud resources.

Open that URL, create an account, and sign out and back in. The page displays the current user and the protected API response without exposing session tokens.

## Verify the HTTP flow

In another terminal in this example directory, paste the printed URL after `read` and press Enter:

```sh
read -r BETTER_AUTH_TEST_URL
export BETTER_AUTH_TEST_URL
timeout 60 bun test
```

The test creates a disposable account and checks cookies, sessions, public access, and sign-out rejection. Use a disposable database rather than production.

## Enable GitHub

```sh
cp .env.example .env
```

Replace the dummy credentials with your GitHub OAuth application's values and enable the provider:

```dotenv
GITHUB_ENABLED=true
GITHUB_CLIENT_ID=your-oauth-client-id
GITHUB_CLIENT_SECRET=your-oauth-client-secret
```

Use the running application's origin to construct the registered callback:

```sh
printf '%s/api/auth/callback/github\n' "$BETTER_AUTH_TEST_URL"
```

Restart the dev command after configuration changes and check its printed URL. Update the registered callback if that URL changed; no fixed local port is required.

The page shows the GitHub button only when enabled. The public provider endpoint exposes that flag, never credentials.

## Deploy

```sh
bun run deploy --stage production
```

Use separate production OAuth credentials and register the deployed callback URL. Optionally set `AUTH_BASE_URL` to your production origin; leave it unset locally to use the incoming request's origin.

Alchemy binds the database, migrates the schema, and preserves the generated signing secret through stack state. Keep that state for later deployments.

## Remove the deployment

```sh
bun run destroy --stage production
```

Use the exact stage and profile of the deployment you intend to remove. The generated browser bundle in `public/ui.js` is ignored by Git.
