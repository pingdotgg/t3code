# Files Macroscope skips during code review and in Check Run Agents.
# This file REPLACES Macroscope's built-in defaults rather than extending them,
# so the defaults are reproduced below (from docs.macroscope.com, Code Review),
# followed by this repository's own entries at the end.
# One glob per line; not Markdown, and excluded from vp fmt for that reason.

# ---- Macroscope defaults ----
# === Vendored / dependency directories ===
**/.git/**
**/__pycache__/**
**/.pytest_cache/**
**/.mypy_cache/**
**/.ruff_cache/**
**/venv/**
**/.venv/**
**/node_modules/**
**/site-packages/**
**/.pnpm-store/**
**/__Snapshots__/**
**/__snapshots__/**
**/.agents/skills/**
**/.claude/skills/**
**/.github/skills/**
**/bower_components/**
**/jspm_packages/**
**/.next/**
**/.svelte-kit/**
**/.nuxt/**
**/.output/**
**/.vercel/**
**/.angular/**
**/vendor/**
**/_vendor/**
**/third_party/**
**/Pods/**
**/.bundle/**
# === Root-anchored ambiguous directories ===
build/**
out/**
env/**
ENV/**
# === Generated / build-output directories (match anywhere) ===
**/target/**
**/dist/**
**/generated/**
**/intermediates/**
**/generated_sources/**
**/generated-sources/**
**/generated-src/**
**/src/main/generated/**
# === Minified build output ===
**/*.min.js
**/*.min.css
**/*.bundle.js
# === Yarn PnP loader files ===
**/.pnp.cjs
**/.pnp.loader.mjs
# === Generated protobuf / codegen files ===
**/*_pb.d.ts
**/*_pb.js
**/*.pb.go
**/*_pb2.py
**/*_pb2_grpc.py
**/*_pb2.pyi
**/*.grpc.swift
**/*.pb.swift
**/*.sql.go
**/*.designer.cs
**/*.g.dart
**/*.pb.dart
**/*_pb.rb
**/*.d.ts
**/*.gen.ts
**/*.gen.tsx
**/*.gen.js
**/*.gen.jsx
# === Package manager files ===
**/go.mod
**/package.json
**/*.pbxproj
**/*.xcstrings
**/*.strings
**/*.properties
**/pom.xml
**/Package.swift
**/bun.lock
**/.eslintrc
**/.eslintignore
# === Lock / sum files ===
**/go.sum
**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
**/Package.resolved
# === Images ===
**/*.jpg
**/*.jpeg
**/*.png
**/*.gif
**/*.svg
**/*.ico
**/*.webp
**/*.bmp
**/*.tiff
# === Fonts ===
**/*.woff
**/*.woff2
**/*.ttf
**/*.eot
**/*.otf
# === Media ===
**/*.mp3
**/*.mp4
**/*.wav
**/*.avi
**/*.mov
**/*.mkv
**/*.flac
**/*.ogg
**/*.srt
# === Archives ===
**/*.zip
**/*.tar
**/*.gz
**/*.rar
**/*.7z
**/*.bz2
# === Documents ===
**/*.pdf
**/*.doc
**/*.docx
**/*.xls
**/*.xlsx
**/*.ppt
**/*.pptx
# === Data / serialized ===
**/*.db
**/*.sqlite
**/*.sqlite3
**/*.parquet
**/*.avro
**/*.arrow
**/*.npy
**/*.pkl
**/*.jsonl
# === ML models ===
**/*.onnx
**/*.tflite
**/*.h5
**/*.safetensors
# === Compiled / binary ===
**/*.exe
**/*.dll
**/*.so
**/*.dylib
**/*.bin
**/*.pyc
**/*.class
**/*.o
**/*.a
**/*.wasm
# === Certificates / keys ===
**/*.cer
**/*.pem
**/*.p12
# === Platform-specific / non-reviewable ===
**/*.stringsdict
**/*.snap
**/*.adoc
**/*.arb
**/*.lock
**/*.po
**/*.fbx
**/*.log
**/*.xib
**/*.meta
**/*.kml
**/*.prefab
**/*.eml
**/*.csv
**/*.grpc.reflection
**/*.js.map
# === Go ===
**/*_test.go
# === TypeScript / JavaScript ===
**/*.test.ts
**/*.test.tsx
**/*.test.js
**/*.test.jsx
**/*.test.mjs
**/*.test.cjs
**/*.test.mts
**/*.test.cts
**/*.spec.ts
**/*.spec.tsx
**/*.spec.js
**/*.spec.jsx
**/*.spec.mjs
**/*.spec.cjs
**/*.spec.mts
**/*.spec.cts
**/*.e2e.ts
**/*.e2e.tsx
**/*.e2e.js
**/*.e2e.jsx
**/*.e2e.mjs
**/*.e2e.cjs
**/*.integration.ts
**/*.integration.tsx
**/*.integration.js
**/*.integration.jsx
**/*.integration.mjs
**/*.integration.cjs
**/__tests__/**
# === Python ===
**/test_*.py
**/*_test.py
# === Java / Kotlin ===
**/*Test.java
**/*Tests.java
**/*Spec.java
**/*IT.java
**/*ITCase.java
**/*Test.kt
**/*Tests.kt
**/*Spec.kt
**/*IT.kt
**/*ITCase.kt
**/src/test/java/**
**/src/test/kotlin/**
**/src/androidTest/**
**/src/integrationTest/**
# === Swift ===
**/*Tests.swift
**/*UITests.swift
**/*Tests/**
**/*UITests/**
# === Rust ===
**/tests/*.rs
**/*_test.rs
**/test_*.rs
# === Ruby ===
**/*_test.rb
**/*_spec.rb
**/test_*.rb
# === Generic test directories ===
**/test/**
**/tests/**
**/spec/**
**/specs/**
**/e2e/**

# ---- t3code ----
# Vendored read-only reference checkouts of upstream Effect and Alchemy
# (see scripts/lib/reference-repos.ts). Nothing imports from them; findings
# there belong upstream.
.repos/**
