# AWS Vite Example

This example builds a Vite app and deploys it with:

- `Build.Build` for the frontend build step
- `AWS.Website.StaticSite` for S3 + CloudFront hosting
- optional ACM + Route 53 custom-domain wiring

## Commands

```sh
bun install
bun run --filter aws-vite-example build
bun run --filter aws-vite-example deploy
```

For local frontend development:

```sh
bun run --filter aws-vite-example dev:vite
```

## Optional Custom Domain

Set these environment variables before deploy:

```sh
export WEBSITE_DOMAIN=app.example.com
export WEBSITE_ZONE_ID=Z1234567890
export WEBSITE_ALIASES=www.app.example.com
```

Without them, the example still deploys and returns the CloudFront URL.
