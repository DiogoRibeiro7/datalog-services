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

The features, the moderation inbox, the OpenAPI description, the conformance
suite and the deployment guide arrive in the next pull requests.

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
