# Built-in protobuf descriptors

From the repository root, after installing workspace dependencies:

```sh
pnpm protobuf-codegen
pnpm protobuf-codegen --check
```

The first command regenerates
`src/protobuf/ProtobufDescriptorProto.ts`. The second
fails if that file differs from the generator output. The descriptor tests run
this check too.

This script generates only the built-in descriptor definitions and interfaces.
It uses Effect's `ProtobufMessage` and the checked-in `FileDescriptorSet`
descriptor to read its input. The generated file therefore supplies the
definitions needed to produce its next version. This is self-hosted generation.

Run generation again after changing the generated definitions, then run
`--check`. The second run must produce the same output. If the generated file is
missing or broken, restore a working version from Git before running the script.
No network access or installed `protoc` is required for generation.

## Pinned inputs

Both inputs come from Protocol Buffers v36.2, commit
`2c74169b34066ceb8ddb6b882fcb3fb32d737a55`. The script verifies their SHA-256
digests before generating output.

- [descriptor.proto](https://github.com/protocolbuffers/protobuf/blob/2c74169b34066ceb8ddb6b882fcb3fb32d737a55/src/google/protobuf/descriptor.proto)
  is copied unchanged into this directory and retained as the upstream source
  reference. The script verifies its checksum but reads the compiled descriptor
  set using Effect's checked-in definitions.
- `../../test/fixtures/protobuf/descriptor-set.binpb` contains descriptors for
  `descriptor.proto` and `compiler/plugin.proto`, including source information.
  This supplies the descriptor values and upstream comments used in the output.

Upstream copyright and license notices are retained in `descriptor.proto` and
in [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md).

## Updating the definitions

1. Select an immutable upstream revision and matching `protoc` release. Replace
   the vendored source with the file from that revision.
2. Rebuild the descriptor-set fixture using that release's include directory:

   ```sh
   protoc --include_source_info --descriptor_set_out=descriptor-set.binpb \
     -I /path/to/protoc/include \
     google/protobuf/descriptor.proto google/protobuf/compiler/plugin.proto
   ```

   Replace `packages/effect/test/fixtures/protobuf/descriptor-set.binpb` with the
   result. Use the selected `protoc` release explicitly; a different release can
   produce different bytes.
3. Update the input digests, upstream revision in the script's output header,
   and provenance in this document and `THIRD_PARTY_NOTICES.md`. Keep public
   `@since` tags tied to the Effect version that introduced each declaration.
4. Run `pnpm protobuf-codegen`, then `pnpm protobuf-codegen --check`. Review the
   generated changes and run the protobuf descriptor and message tests,
   `pnpm check`, `pnpm jsdocs --check`, and `pnpm lint`.

The renderer is deliberately limited to this descriptor file. It fails on
unsupported constructs such as oneofs so an upstream change requires an explicit
renderer update. It also rejects fields that the checked-in descriptor definitions
do not recognize, so an update cannot silently lose them from the generated output.
