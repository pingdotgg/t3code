# Third-party notices

This package is licensed under the [MIT license](LICENSE).

Selected JOSE contracts and fixtures are adapted from the pinned upstream
snapshot below. The runtime uses Effect services; the npm `jose` package is
used only for tests and independent interoperation.

## JOSE contracts

Selected public contract tests in [test/jose/](test/jose/) follow behaviours exercised by
[panva/jose](https://github.com/panva/jose/tree/505a55b8f73536082367b2614cb77e927ba96ec1),
v6.2.12, commit `505a55b8f73536082367b2614cb77e927ba96ec1` (Filip Skokan).
The selected source contracts are adapted to the supported profile:

| Upstream tests                                                                                                                   | Local tests              |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `test/jws/compact.verify.test.ts`, `test/jws/flattened.verify.test.ts`, `test/jws/crit.test.ts`, `test/jws/restrictions.test.ts` | `test/jose/Jws.test.ts`  |
| `test/jwk/jwk2key.test.ts`, `test/jwk/key_input.test.ts`                                                                         | `test/jose/Jwk.test.ts`  |
| `test/jwt/verify.test.ts`                                                                                                        | `test/jose/Jwt.test.ts`  |
| `test/jwks/local.test.ts`, `test/jwks/remote.test.ts`                                                                            | `test/jose/Jwks.test.ts` |
| `test/jwe/compact.encrypt.test.ts`, `test/jwe/compact.decrypt.test.ts`, `test/jwe/flattened.decrypt.test.ts`                     | `test/jose/Jwe.test.ts`  |

Only applicable public behavior is adapted; flattened-format tests supply shared
header and authentication-tag validation, not JSON serialization support. Known
answer vectors come from RFC 7515 Appendix A. Tests use independent
interoperation against that release, plus Effect-specific policy, scoped
cancellation and refresh-coalescing regressions. This is not a full upstream
suite port or a claim of full upstream compatibility.

The source implementation informs claim validation, protected-header policy, and
key selection in `src/jose/Jwt.ts`, `src/jose/Jws.ts`, `src/jose/Jwk.ts`, `src/jose/Jwks.ts`, and
`src/jose/Jwe.ts`; these implementations are written for Effect services and Schema.
No panva/jose runtime implementation is bundled or required.

The wire formats follow RFC 7515, RFC 7516, RFC 7517, RFC 7518, RFC 7519,
and RFC 8037; policy follows RFC 8725. The only RFC material copied is the
RFC 7515 Appendix A example keys and tokens used as test vectors.

### panva/jose — MIT

The MIT License (MIT)

Copyright (c) 2018 Filip Skokan

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

## Protocol Buffers descriptors

The protobuf descriptor definitions and copied comments come from
[protocolbuffers/protobuf v36.2](https://github.com/protocolbuffers/protobuf/tree/2c74169b34066ceb8ddb6b882fcb3fb32d737a55),
commit `2c74169b34066ceb8ddb6b882fcb3fb32d737a55`:

- [The descriptor source](scripts/protobuf/descriptor.proto) is an unchanged copy
  of upstream `descriptor.proto`. See the [regeneration procedure](scripts/protobuf/README.md).
- [The generated descriptor module](src/protobuf/ProtobufDescriptorProto.ts)
  contains definitions and comments from upstream
  [descriptor.proto](https://github.com/protocolbuffers/protobuf/blob/2c74169b34066ceb8ddb6b882fcb3fb32d737a55/src/google/protobuf/descriptor.proto).
- [The descriptor-set test fixture](test/fixtures/protobuf/descriptor-set.binpb)
  contains protoc 36.2 output with source information for that file and
  [compiler/plugin.proto](https://github.com/protocolbuffers/protobuf/blob/2c74169b34066ceb8ddb6b882fcb3fb32d737a55/src/google/protobuf/compiler/plugin.proto).

The copyright notice in `descriptor.proto` is:

```text
Copyright 2008 Google LLC.  All rights reserved.
```

### Protocol Buffers BSD license

The following text is reproduced from the pinned upstream
[LICENSE](https://github.com/protocolbuffers/protobuf/blob/2c74169b34066ceb8ddb6b882fcb3fb32d737a55/LICENSE).

```text
Copyright 2008 Google Inc.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

    * Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above
copyright notice, this list of conditions and the following disclaimer
in the documentation and/or other materials provided with the
distribution.
    * Neither the name of Google Inc. nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

Code generated by the Protocol Buffer compiler is owned by the owner
of the input file used when generating it.  This code is not
standalone and requires a support library to be linked with it.  This
support library is itself covered by the above license.
```

## Scalar API Reference

`HttpApiScalar.layer` bundles the standalone browser script from `@scalar/api-reference` v1.81.0,
licensed under the [MIT license](https://github.com/scalar/scalar/blob/98a8140ffa5fa459159704b20d7742b7ad6f8d6b/LICENSE).

MIT License

Copyright (c) 2023-present Scalar

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
