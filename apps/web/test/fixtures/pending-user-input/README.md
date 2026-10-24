# Pending question evidence fixtures

Run `node apps/web/test/fixtures/pending-user-input/request.mjs multi` or
`node apps/web/test/fixtures/pending-user-input/request.mjs single` from the repo
root. Paste the output into a Claude thread in an isolated development server.
The provider must only ask the question; it must not execute the example command.

`multi` exercises wrapped labels and descriptions, inline question code, an empty
description, and a description identical to its label. Select **Wait** for the
matched stills, leaving the other options unselected. Keep the request pending
while testing selection, clipboard paste, ordinary clicks, keyboard activation,
and collapse/reopen. `single` has a nonterminal and terminal question. Reissue it
for each activation method because the terminal answer consumes the request.

These are public synthetic inputs, not database rows or provider credentials.
Provider-generated request/question identifiers can differ. Claude's four-option
limit prevents this live fixture from covering the ninth/tenth option. Permission
disabled, in-flight responding, and nonresumable states require separate real
runtime conditions; changing these inputs does not establish those conditions.
