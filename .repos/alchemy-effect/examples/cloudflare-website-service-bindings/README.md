# Cloudflare Website service bindings

One stack runs nine Websites together, each behind its own Gateway Worker:
SvelteKit, Nuxt, Next.js HMR, Next.js preview, Octane, Astro, Waku, Vocs, and Vinext.
The small apps live in `apps/`, with independent dependencies and build directories.

Each Website has `workersDev: false` and caching enabled. Its uncached Gateway
forwards requests with `env.WEBSITE.fetch(request)`. The stack outputs each pair's
`websiteUrl` and `gatewayUrl`; the Website URL is only available in local dev.
Local ports are allocated automatically. State is stored locally.

## Commands

From this directory:

```sh
vpr dev       # start all nine Websites and Gateways together
vpr deploy    # deploy the complete stack
vpr destroy   # tear down the stack
vpr test      # run the standard dev and deployed integration tests
```

This example is included in the repository's normal `vpr test:examples` run.
It uses the same Cloudflare authentication/profile setup as the other examples.

## Tests

`test/dev.test.ts` starts the whole stack once with `Test.make({ dev: true })`.
It checks every Website directly and then through its Gateway's service binding.
`test/integ.test.ts` deploys the whole stack and checks each Gateway against its
private Website. Both suites destroy their stack after testing.

The dev tests guard against [#1796](https://github.com/alchemy-run/alchemy/issues/1796):
all nine Gateways must reach their private Websites through local service bindings
and return 200 with the expected page content.
