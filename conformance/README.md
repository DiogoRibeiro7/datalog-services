# Conformance suite

Checks that a backend answers the DataLog theme's
[dynamic-services contract](https://github.com/DiogoRibeiro7/analytics-blog-jekyll/blob/develop/docs/dynamic-services.md)
the way the theme's pages expect: discovery and versions, the error body and
request ids, CORS with and without credentials, each feature's shapes and
status codes, the fields a 422 names, idempotent retries, CSRF on the
moderation writes and `429` with `Retry-After`. Every answer it reads is also
validated against [the OpenAPI description](../openapi/datalog-services.v1.yaml).

It runs against a base URL, so it checks any implementation, not only the
one in this repository.

## Run it

Node 22.13 or later, from a checkout of this repository after `npm install`:

```sh
npm run conformance -- --base-url https://api.example.org --origin https://example.org
```

| Option | Meaning |
| --- | --- |
| `--base-url` | The service, as the site's `dynamic_services.base_url` names it. Required. |
| `--origin` | The site's origin, which the service must serve (CORS). Required. |
| `--site-url` | The site's address for article and page URLs, when not the origin itself. |
| `--api-version` | The version the site expects; `1` by default. |
| `--hooks-token` | The service's test-hook token, for the checks that need a moderator session, a mailbox or a verified Webmention (below). |
| `--moderator` | A login the service lets moderate; `conformance-moderator` by default. |
| `--rate-limit-probe` | How many writes to send while looking for a `429`; 60 by default. |
| `--strict` | Fail on the recommended checks as well as the required ones. |
| `--report FILE` | Also write every check's outcome as JSON. |
| `--only` | Some groups only: `core`, `comments`, `reactions`, `corrections`, `contact`, `subscriptions`, `webmentions`, `moderation`, `rate-limits`. |

It exits `0` when every required check passed, `1` when one failed, and `2`
when the service's capabilities could not be read at all. The report lists
each check with ✔ or ✖, and each failure says what was expected and what the
service answered, with the request and the body:

```
✖ a write whose body is not JSON is refused with a 4xx in the error body, not a 5xx
  AssertionError: A malformed body must be the client's error. POST /v1/corrections answered 500: {"message":"Internal error"}
```

**Run it against a test deployment**, never one with readers: it posts
comments, reports, messages and subscriptions, spends the client's rate-limit
allowance, and, with the hooks, empties the database between groups.

## What it checks

A group runs only when the service's capabilities offer its feature, and
says so when it is skipped.

- **core**: capabilities and the version the site expects (a mismatch is
  reported as the theme would show it), another version not served as this
  one, `X-Request-Id` on success and failure, the error body with
  `request_id`, 404 for an unknown address, a malformed body answered as the
  client's error, CORS for the site's exact origin with credentials, the
  exposed headers, a preflight allowing the methods and headers the client
  sends, and no foreign origin allowed.
- **comments**, **reactions**, **corrections**, **contact**,
  **subscriptions**, **webmentions**: each route's status codes and shapes,
  the fields a 422 names, nothing private echoed, a retry with the same
  `Idempotency-Key` stored once, and, where the hooks allow it, the whole
  path: a comment approved and served oldest first, a subscription confirmed,
  read, changed and ended from the links in its emails, verified mentions
  newest first.
- **moderation**: 401 without a session and 403 for an account that may
  not moderate, both without items; CORS with credentials; the queue; the
  documented transitions with a 409 for any other and a 422 for a resolution
  without a link; an action from another origin refused.
- **rate-limits**, last: writes to one feature until a `429`, which must carry
  `Retry-After`.

Checks marked "(recommended)" follow the reference service's behaviour where
the contract allows more than one answer, such as a 405 for a wrong method or
a 409 for a second reaction. They are reported but fail the run only with
`--strict`.

## Test hooks

Some checks need what a black box cannot give: a signed-in moderator, the
links in a confirmation email, a Webmention that has been verified. A service
may offer four test-only routes, authenticated with a bearer token, and the
suite uses them when given `--hooks-token`:

| Route | Does |
| --- | --- |
| `POST /_conformance/reset` | Empties the service's data. |
| `POST /_conformance/session` `{ "login" }` | Answers `{ "cookie" }`, the Cookie header of a session for that login. |
| `GET /_conformance/outbox?to=<address>` | Answers `{ "messages": [{ "to", "subject", "text", "headers" }] }`, the mail sent to an address. |
| `POST /_conformance/webmentions` `{ "source", "target", "type", "title", ... }` | Stores a verified mention. |

The reference service serves them only when `CONFORMANCE_TOKEN` is set, and
never should on a deployment with real data. Without hooks, the checks that
need them are skipped and name the reason; the rest still run.

## Claiming conformance

A backend conforms to version 1 of the contract when a run without `--strict`
exits `0` against a deployment offering the features it claims, with the
hooks, so that nothing is skipped. Quote the command and the suite's commit.

## Its own tests

`test/conformance.test.js` runs the suite against the reference service
(every check passes, recommended ones included) and against
`test/fixtures/broken-service.js`, a service with a dozen deliberate faults,
where it must fail and name each of them.
