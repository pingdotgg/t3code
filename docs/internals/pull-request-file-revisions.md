# Pull request file revisions

On a host that keeps no viewed-file record of its own, this environment keeps the marks and asks
the host what version each marked file is at, so that a push can report a cleared file as changed.
That version travels through four layers, and a missing entry means something different at each
one. No type distinguishes those meanings and no single file states the whole path, which is what
this page is for.

The failure is on record rather than hypothetical. The interface doc above
[GitLab's `getFileRevisions`](../../apps/server/src/pullRequest/GitLabPullRequestCli.ts) once said
the opposite of the code beneath it, because it described a missing path the way the layer below
means it. Anything written against that reading would treat a version the host declined to give as
a file the change request deleted, which reports every file a reader has cleared as changed across
a project the token cannot see.

## An absence changes meaning at the provider boundary

Below the boundary, in a patch parser or a response decoder, a missing path means this revision
does not carry that file. Above it, in
[`ProviderFileRevisions`](../../apps/server/src/pullRequest/PullRequestProvider.ts), a missing path
means the read could not say. A provider's `getFileRevisions` converts on the way up: a path its
host looked at and has no version for arrives as the empty string, and absence is kept for what
the provider never got to look at. Absence below the boundary does not survive it.

What "never got to look at" is belongs to the host, and the contract cannot know any of them:

- [Azure DevOps](../../apps/server/src/pullRequest/AzureDevOpsPullRequestProvider.ts) reads every
  version off one iteration listing, so a change too long to follow to its end leaves the paths
  past that point out.
- [Bitbucket](../../apps/server/src/pullRequest/BitbucketPullRequestApi.ts) reads them off the
  pull request's own patch, the only place it states a file's version, so a patch cut short at the
  byte ceiling leaves the paths past the cut out.
- [GitLab](../../apps/server/src/pullRequest/GitLabPullRequestCli.ts) asks in batches, so a batch
  it could not read leaves that batch's paths out.

Those three facts stay with their providers. The contract states only that absence means the read
could not say, which is the half a provider must convert to.

## Three nulls, and the empty string is not one of them

The empty string is an answer: the host looked, and the head has no version, which is where a
deleted file sits. It compares equal to a mark stamped with it, so a mark taken against a deletion
is cleared once and stays cleared. Everything below is the absence of an answer, and the three
forms are not interchangeable.

A null map, from the service's read of the whole scope, costs those marks their staleness. They
still report as cleared; they stop noticing pushes. It happens when the provider offers no
`getFileRevisions` at all, and, on the read path only, when the call failed and was logged. A
press takes the stricter line and fails loudly, since a mark stamped with a revision nobody read
is wrong rather than merely less informed.

A path absent from an answered map is the per-path case, and it is the one that must not be read
as a deletion. [`HeldFileRevisions`](../../apps/server/src/pullRequest/pullRequestViewedFiles.ts)
records what it has asked as well as what it heard, so an absent path keeps the last version given
for it instead of losing one.

A null on the stored mark is the third, and the only one this environment invents.
[`PullRequestFileViewedMark`](../../apps/server/src/persistence/PullRequestFilesViewed.ts) stores
`revision` as nullable so a press that got no answer for a path can store no baseline at all.
Storing the empty string instead would report the file as changed the moment the host turned out
to have a version after all. A mark with no baseline reads as cleared until the reader presses it
again.

Both read-side nulls collapse into that third one on the write path: whether the map was null or
the path was only absent from it, the press stores a mark with no baseline.
