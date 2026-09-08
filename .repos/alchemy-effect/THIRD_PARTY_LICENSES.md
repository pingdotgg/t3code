# Third-Party Licenses

Alchemy is licensed under the Apache License 2.0. Portions of the repository
are derived from the projects listed below and remain subject to their
respective license notices.

## Astro

Portions of `packages/cloudflare-frameworks/src/astro` are derived from
`@astrojs/cloudflare`.

Copyright (c) 2021 Fred K. Schott

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## SvelteKit

Portions of `packages/cloudflare-frameworks/src/sveltekit` are derived from
`@sveltejs/adapter-cloudflare`.

Copyright (c) 2020 SvelteKit contributors

The SvelteKit portions are provided under the MIT License reproduced in the
Astro section above.

## Waku

Portions of `packages/cloudflare-frameworks/src/waku` are derived from Waku.

Copyright (c) 2023 Daishi Kato

The Waku portions are provided under the MIT License reproduced in the Astro
section above.

## Cloudflare Workers SDK and Miniflare

Portions of `packages/cloudflare-runtime`, including the vendored
`workers-shared` and `workflows-shared` source trees and local binding
implementations adapted from Miniflare, are derived from Cloudflare's
`workers-sdk` repository. Alchemy uses these portions under the MIT option of
the upstream `MIT OR Apache-2.0` license.

Copyright (c) 2020 Cloudflare, Inc. <wrangler@cloudflare.com>

The Cloudflare Workers SDK and Miniflare portions are provided under the MIT
License reproduced in the Astro section above.

## OpenNext for Cloudflare

Portions of `packages/cloudflare-frameworks/src/nextjs`, including the build
runner and development-context integration, are derived from OpenNext for
Cloudflare.

Copyright (c) 2020 Cloudflare, Inc.

The OpenNext portions are provided under the MIT License reproduced in the
Astro section above.

## SST

`packages/alchemy/src/AWS/Website/cfcode.ts` contains CloudFront Function code
ported from SST's Router component.

Copyright (c) 2024 SST

The SST portions are provided under the MIT License reproduced in the Astro
section above.

## node-sanitize-filename

Path-sanitization expressions in
`packages/cloudflare-runtime/src/core/internal/shared.worker.ts` are adapted
from `node-sanitize-filename` and used under its ISC license option.

Copyright Parsha Pourkhomami

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.

## node-ignore

`packages/node-utils/src/ignore.ts` is a TypeScript port
of `ignore` (node-ignore) v7.0.5.

Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors

The node-ignore portions are provided under the MIT License reproduced in the
Astro section above.

## SQLite

The D1 simulator contains a TypeScript port of SQLite shell quoting logic.
SQLite's deliverable source code, including its command-line interface, has
been dedicated to the public domain. See <https://www.sqlite.org/copyright.html>.

## Upstream source references

- Astro: <https://github.com/withastro/astro>
- SvelteKit: <https://github.com/sveltejs/kit>
- Waku: <https://github.com/wakujs/waku>
- Cloudflare Workers SDK: <https://github.com/cloudflare/workers-sdk>
- OpenNext for Cloudflare: <https://github.com/opennextjs/opennextjs-cloudflare>
- SST: <https://github.com/sst/sst>
- node-sanitize-filename: <https://github.com/parshap/node-sanitize-filename>
- node-ignore: <https://github.com/kaelzhang/node-ignore>
- SQLite: <https://github.com/sqlite/sqlite>

The external `.vendor` Git submodules are separate works governed by the
license files in their respective repositories. This notice covers code copied
or adapted into the Alchemy repository; it does not replace the license
documentation within those submodules.
