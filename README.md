# datalog-services

The reference backend for the [DataLog theme](https://github.com/DiogoRibeiro7/analytics-blog-jekyll)'s
[dynamic-services contract](https://github.com/DiogoRibeiro7/analytics-blog-jekyll/blob/develop/docs/dynamic-services.md):
comments, reactions, correction reports, the contact form, newsletter
subscriptions, Webmentions and the moderation inbox, for a static site that has
no server of its own.

It is kept apart from the theme on purpose: the theme gem ships no server code,
and this service has its own release cycle.

## What is here so far

The core every feature runs through:

- `GET /v1/capabilities`, listing the seven features, each on or off as
  `FEATURES` says, and `GET /v1/health`;
- the contract's error body, `{ "error": { "code", "message", "errors" }, "request_id" }`,
  and an `X-Request-Id` on every answer;
- CORS for the site's exact origin, with credentials, and a refusal for any
  other origin;
- `Idempotency-Key` on writes: a retry is answered from the stored result;
- rate limits per client address, kept in the database, answered with `429`
  and `Retry-After`;
- a SQL store that runs on Cloudflare D1 and, for development and tests, on
  Node's built-in SQLite through the same queries.

And the features readers use:

| Feature | Routes | Notes |
| --- | --- | --- |
| comments | `GET /v1/comments?path=`, `POST /v1/comments` | Held for moderation unless `COMMENTS_MODERATION=false`; replies only to a published comment of the same page; at most `COMMENTS_MAX_LINKS` (2) links; the email kept only as a keyed hash |
| comments (extension) | `POST /v1/comments/:id/reports` | A reader's report on a published comment, for the moderation inbox's `abuse` items; the theme has no button for it yet |
| reactions | `GET /v1/reactions?path=`, `POST /v1/reactions` | `REACTION_TYPES`; one reaction per reader per page per day, the reader a keyed hash of address, page and day; a second is a `409` |
| corrections | `POST /v1/corrections` | `CORRECTION_CATEGORIES`; only for pages of the site; stored privately with status `new` |
| contact | `POST /v1/contact` | `CONTACT_CATEGORIES`; stored privately, never published; a copy to `CONTACT_TO` when mail is set up |
| subscriptions | `POST /v1/subscriptions`, `POST /v1/subscriptions/confirm`, `GET`/`PATCH`/`DELETE /v1/subscriptions/:token`, `POST /mail/unsubscribe/:token` | Double opt-in; signed links that stop working when the subscriber leaves; membership not disclosed unless `SUBSCRIPTIONS_DISCLOSE=true`; RFC 8058 one-click unsubscribe; needs `MAIL_PROVIDER` |
| webmentions | `GET /v1/webmentions?target=`, `POST /webmention` | The W3C receiver answers `202` and then fetches the source, confirms the link and reads title, author, date, kind and excerpt as plain text; only verified mentions are served |

Mail goes through [Resend](https://resend.com) (`MAIL_PROVIDER=resend`, with
the `RESEND_API_KEY` secret and `MAIL_FROM`) or, for development and the
conformance suite, into an `outbox` table (`MAIL_PROVIDER=outbox`).

And the one feature for the site's owner:

| Feature | Routes | Notes |
| --- | --- | --- |
| moderation | `GET /v1/moderation/items`, `POST /v1/moderation/items/:id/actions` | The queue of pending comments, open correction reports and readers' reports on comments, with the theme's filters and a cursor; the actions of the theme's table, a 409 for any other; every action recorded with the moderator the session names |
| sign-in | `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout` | Moderators sign in with GitHub; the logins in `MODERATORS` may moderate, anyone else gets a 403 |

The session is a cookie the service signs (`HttpOnly; Secure`, eight hours,
`SameSite=None` since the site is usually on another domain). A moderation
write must come from the site's origin and, with `CSRF_HEADER` and
`CSRF_COOKIE` set, echo the CSRF cookie in the header. When the site and the
service share a registrable domain, set `COOKIE_DOMAIN` and
`COOKIE_SAMESITE=Lax`: browsers that block third-party cookies (Safari,
Firefox's strict mode) then keep the session.

The OpenAPI description, the conformance suite and the deployment guide
arrive in the next pull requests.

## Run it locally

Node 22.13 or later.

```sh
npm install
cp .dev.vars.example .dev.vars     # then set SECRET_KEY, ALLOWED_ORIGINS and FEATURES
npm run dev                        # http://127.0.0.1:8787/v1/capabilities
```

The database is `.data/dev.sqlite`, created with the migrations in
`migrations/` applied; `DATABASE=:memory:` keeps nothing.

```sh
npm test                           # node:test, against an in-memory database
npm run lint
```

## How a request is handled

`src/app.js` turns the service into one `fetch(request)` function on the Web
platform's `Request` and `Response`, which is what a Cloudflare Worker runs;
`src/node.js` serves the same function from Node. Every request under `/v1`
gets, in order: a request id, the origin check, the preflight answer, its
route and the feature switch, for a write the JSON body and the idempotency
key, the rate limit, and the handler.

Every setting is an environment variable; `.dev.vars.example` lists them.
Secrets never go in the repository: locally they live in `.dev.vars`, which
Git ignores.

## Licence

[MIT](LICENSE)
