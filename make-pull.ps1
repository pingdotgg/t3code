# Fetches and resets main to origin/main, as `make pull` does. Discards tracked changes.

Set-Location -LiteralPath $PSScriptRoot
if ((git branch --show-current) -ne 'main') {
  [Console]::Error.WriteLine('Switch to main before running make-pull.ps1.')
  exit 1
}
git fetch origin
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
git reset --hard origin/main
exit $LASTEXITCODE
