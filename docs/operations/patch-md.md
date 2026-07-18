# Maintaining a customized T3 Code fork with PatchMD

PatchMD keeps the reason for downstream changes available after upstream code
moves or is rewritten. Git remains the implementation record. Root `PATCH.md`
records the outcome each customization must preserve.

## Customize

Use `.agents/skills/modify-with-patch-md/SKILL.md` when deliberately changing
T3 Code-owned behavior in a downstream fork. Keep the code and its intent entry
in the same logical commit. Entries describe observable behavior and
reconstruction constraints rather than old source text.

## Update

Use `.agents/skills/update-with-patch-md/SKILL.md` before rebasing the fork onto
`pingdotgg/t3code:main`. The workflow requires a clean tree and recovery ref,
tries normal Git replay first, preserves displaced bytes, prefers new upstream
code during uncertainty, audits every active intent, and verifies the result.

Conflicts are semantic work. Compare the new upstream implementation, previous
downstream implementation, and matching intent. Rebuild the outcome on the new
architecture only after approval. If upstream now satisfies the outcome, remove
redundant downstream behavior and mark the entry `retired` with a reference.

## Review and adoption

An update is complete only after the repository's checks pass and the
maintainer has reviewed which customizations were preserved, reconstructed,
retired, or left unresolved. The workflow never pushes, deploys, force-pushes,
or deletes recovery data without approval.

PatchMD is a draft convention maintained at
<https://github.com/ElliotDrel/PATCH-md>. It is inspired by Theo Browne's
[patch.md idea](https://www.youtube.com/watch?v=G1xqTjoihfo&t=1970s).
