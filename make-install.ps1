# Installs the latest desktop release, as `make install` does. With -FromSource, builds and
# installs the checked-out commit instead, as `make install-source` does.
param([switch]$FromSource)

Set-Location -LiteralPath $PSScriptRoot
$arguments = @('scripts/fork/install-desktop.ts')
if ($FromSource) { $arguments += '--from-source' }
node @arguments
exit $LASTEXITCODE
