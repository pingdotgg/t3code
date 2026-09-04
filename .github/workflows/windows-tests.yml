# On-demand Windows test lane. Manual only: nothing in the suite passes on
# Windows yet, so this exists to give contributors (and agents) a cloud Windows
# box to iterate against. Once the suite is green here, fold it into ci.yml.
#
#   gh workflow run windows-tests.yml --ref <branch> -f package=packages/shared
#   gh workflow run windows-tests.yml --ref <branch> -f package=apps/server \
#     -f files="src/process/externalLauncher.test.ts src/cli/theme.test.ts"
#   gh run watch && gh run view --log-failed
name: Windows Tests

on:
  workflow_dispatch:
    inputs:
      package:
        description: "Workspace directory to test, e.g. apps/server or packages/shared. Empty runs every package except apps/server."
        type: string
        default: ""
      files:
        description: "Space-separated test files relative to the package directory. Empty runs the package's whole suite. Requires package."
        type: string
        default: ""

permissions:
  contents: read

jobs:
  test:
    name: Test (${{ inputs.package || 'all non-server' }})
    runs-on: blacksmith-8vcpu-windows-2025
    timeout-minutes: 45
    steps:
      - name: Checkout
        uses: actions/checkout@v6
        with:
          sparse-checkout: |
            /*
            !/.repos/
          sparse-checkout-cone-mode: false

      # setup-vp's own cache restores a Linux-shaped store on Windows, which is
      # slower than no cache (see #7975). Cache pnpm's Windows store directly.
      - name: Setup Vite+
        uses: voidzero-dev/setup-vp@v1
        with:
          node-version-file: package.json
          cache: false
          run-install: false

      - name: Resolve package cache path
        id: package_cache_path
        shell: pwsh
        run: '"path=$(vp pm cache dir)" >> $env:GITHUB_OUTPUT'

      - name: Cache packages
        uses: actions/cache@v6
        with:
          path: ${{ steps.package_cache_path.outputs.path }}
          key: windows-tests-packages-v1-${{ hashFiles('pnpm-lock.yaml') }}

      - name: Install
        run: vp install

      - name: Ensure Electron runtime is installed
        if: inputs.package == '' || inputs.package == 'apps/desktop'
        run: vp run --filter "@t3tools/desktop" ensure:electron

      # `vp run ... test -- <files>` does not forward positional args to vitest,
      # so file-scoped runs call `vp test run` inside the package instead.
      - name: Test
        shell: pwsh
        run: |
          $package = '${{ inputs.package }}'
          $files = '${{ inputs.files }}'
          if ($package -eq '') {
            vp run --parallel --concurrency-limit 4 --filter '!t3' --filter '!@t3tools/monorepo' test
          } elseif ($files -eq '') {
            vp run --filter "./$package" test
          } else {
            Set-Location $package
            vp test run $files.Split(' ')
          }
