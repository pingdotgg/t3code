# AWS Static Site Example

This example deploys a static website from the local `site/` directory using:

- `AWS.Website.StaticSite`
- private S3 origin
- CloudFront distribution
- optional ACM certificate in `us-east-1`
- optional Route 53 alias records

## Commands

```sh
bun install
bun run --filter aws-static-site-example deploy
```

## Optional Custom Domain

Set these environment variables before deploy:

```sh
export WEBSITE_DOMAIN=www.example.com
export WEBSITE_ZONE_ID=Z1234567890
export WEBSITE_ALIASES=example.com,static.example.com
```

When `WEBSITE_DOMAIN` and `WEBSITE_ZONE_ID` are provided, the example will:

- request an ACM certificate
- create Route 53 validation records
- create Route 53 alias records to CloudFront

Without them, the example still deploys and returns the CloudFront URL.
