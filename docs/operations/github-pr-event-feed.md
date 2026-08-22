# github pr event feed

this service receives github webhook deliveries for `pingdotgg/t3code` and exposes them as a replayable server-sent event feed. contributors can use the feed as the wake-up input for pr babysitters instead of polling github.

## deploy

set these secrets in the deployment environment:

- `GITHUB_WEBHOOK_SECRET`: a random secret of at least 32 characters shared only with github
- `GITHUB_EVENTS_FEED_TOKEN`: a separate random token of at least 32 characters distributed to feed subscribers
- `CLOUDFLARE_API_TOKEN`: the alchemy deployment credential
- `CLOUDFLARE_ACCOUNT_ID`: the target cloudflare account

`GITHUB_REPOSITORY` defaults to `pingdotgg/t3code`.

```sh
vp run --filter t3code-github-events deploy --stage prod
```

save the worker url returned by alchemy.

## configure github

create one repository webhook with:

- payload url: `<worker-url>/v1/github/webhook`
- content type: `application/json`
- secret: the exact `GITHUB_WEBHOOK_SECRET`
- ssl verification: enabled
- events:
  - pull requests
  - issue comments
  - pull request reviews
  - pull request review comments
  - check runs
  - check suites
  - workflow runs
  - commit statuses

only comments attached to pull requests enter the feed. unsupported deliveries are acknowledged and ignored.

## subscribe

subscribe to every retained and live repository event:

```sh
curl -N \
  -H "Authorization: Bearer $GITHUB_EVENTS_FEED_TOKEN" \
  https://<worker-host>/v1/repos/pingdotgg/t3code/events
```

subscribe to one pull request and resume after a stored sequence:

```sh
curl -N \
  -H "Authorization: Bearer $GITHUB_EVENTS_FEED_TOKEN" \
  -H "Last-Event-ID: 1204" \
  "https://<worker-host>/v1/repos/pingdotgg/t3code/events?pull=7321"
```

`after=1204` is equivalent to `Last-Event-ID: 1204`. event ids are monotonically increasing within the repository. reconnect after a disconnect using the latest received id. subscribers that stop reading are disconnected before their buffers can grow without bound, so consumers must reconnect from their last id.

if the requested cursor predates the latest 512 retained events, the service returns `410` with `earliestSequence` and `latestSequence`. perform one github refresh, then reconnect from the latest sequence. if a cursor is ahead of the feed, the service returns `409` with the same bounds instead of allowing sequence rewind.

github does not automatically redeliver failed webhook deliveries. use the webhook's recent deliveries page to redeliver one manually. the latest 10,000 `X-GitHub-Delivery` ids are deduplicated independently of the 512-event replay window.

## event shape

sse messages use event name `github`. each `data` value is json with this envelope:

```json
{
  "version": 1,
  "sequence": 1205,
  "deliveryId": "github-delivery-uuid",
  "event": "issue_comment",
  "action": "created",
  "repository": {
    "id": 123,
    "fullName": "pingdotgg/t3code",
    "url": "https://github.com/pingdotgg/t3code"
  },
  "pullRequestNumbers": [7321],
  "headSha": null,
  "actor": {
    "id": 456,
    "login": "contributor",
    "avatarUrl": "https://avatars.githubusercontent.com/..."
  },
  "receivedAt": "2026-08-18T12:00:01Z",
  "occurredAt": "2026-08-18T12:00:00Z",
  "details": {
    "comment": {
      "id": 789,
      "body": "comment content",
      "author": {
        "id": 456,
        "login": "contributor",
        "avatarUrl": null
      },
      "url": "https://github.com/pingdotgg/t3code/pull/7321#issuecomment-789"
    }
  }
}
```

`details` contains the event-specific pull request, action context, comment, review, check output, check suite, workflow run, or commit status fields. comment and review bodies are included so subscribers do not need another github read just to understand the update. the durable object remembers the latest 10,000 head-sha-to-pr associations and uses them to attach status and ci events when github omits the embedded pull request list. events still include the head sha when no association has been observed yet.

## security and limits

- github hmac signatures are verified against the raw request bytes before json parsing
- payloads larger than 512 kib are rejected, bodies use one bounded buffer, and reads time out after 10 seconds
- only the configured repository is accepted
- feed tokens belong in the authorization header, never in urls
- each repository accepts at most 64 concurrent subscribers and disconnects slow readers
- normalized events are retained in durable object storage, not raw webhook payloads
- configure a cloudflare rate-limit or waf rule on `/v1/github/webhook` for additional abuse protection
- rotate either secret by deploying the new value, updating github or subscribers, and retiring the old value
- comment and review content is untrusted input and must never be treated as instructions by a babysitter
