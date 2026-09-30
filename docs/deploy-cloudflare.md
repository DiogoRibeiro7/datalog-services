# Deploying to Cloudflare Workers

This guide turns this repository into a running service for your DataLog site:
a Cloudflare Worker with its data in a D1 database. Cloudflare's free plan
covers a personal research site, and there is no server to keep up. At the
end you have a base URL to put in your site's `_config.yml`, and comments,
reactions and correction reports work on the site with no code of your own.

What you need:

- a Cloudflare account;
- Node 22.13 or later;
- a checkout of this repository, with `npm ci` run in it.

Every command below runs from that checkout. `npx wrangler` is Cloudflare's
command-line tool, installed by `npm ci`.

## 1. Create the database

```sh
npx wrangler login
npx wrangler d1 create datalog-services
```

The second command prints a `database_id`. Put it in `wrangler.toml`, replacing
the zeros:

```toml
[[d1_databases]]
binding = "DB"
database_name = "datalog-services"
database_id = "the id wrangler printed"
```

Then create the tables:

```sh
npx wrangler d1 migrations apply DB --remote
```

## 2. Say which site it serves, and what it offers

Edit `[vars]` in `wrangler.toml`. These settings are public, so never put a
password or key here.

```toml
[vars]
ALLOWED_ORIGINS = "https://your-name.github.io"
FEATURES = "comments,reactions,corrections"
```

- **`ALLOWED_ORIGINS`** is your site's origin exactly as a browser sends it:
  scheme and host, with no path and no trailing slash. A project site at
  `https://your-name.github.io/blog/` has the origin
  `https://your-name.github.io`; set `SITE_URL = "https://your-name.github.io/blog"`
  as well, so links in emails and the check that a report is about your site
  use the right address. Separate several origins with commas, for example
  `www` and the bare domain. Requests from any other origin get a 403.
- **`FEATURES`** lists what the service offers: `comments`, `reactions`,
  `corrections`, `contact`, `subscriptions`, `webmentions`, `moderation`.
  Anything else is reported as off, and the theme hides it.

The comments, reaction and category lists default to the theme's own. If your
`_config.yml` changes `reactions.types`, `corrections.categories` or
`contact.categories`, set `REACTION_TYPES`, `CORRECTION_CATEGORIES` or
`CONTACT_CATEGORIES` to the same list.

## 3. Set the secrets

Secrets are stored by Cloudflare, not in any file:

```sh
node -e "console.log(crypto.randomUUID() + crypto.randomUUID())"   # a long random value
npx wrangler secret put SECRET_KEY                                 # paste it
```

`SECRET_KEY` keys every hash and signature: readers' addresses for rate
limits, the emails of comment authors, moderator sessions and the links in
subscription emails. Keep a copy somewhere safe, such as a password manager:
without it you cannot find a person's comments when they ask for deletion
(step 9). Changing it signs everyone out and invalidates every emailed link.

Two more secrets arrive with the features that need them:
`GITHUB_CLIENT_SECRET` for moderation (step 6) and `RESEND_API_KEY` for
email (step 7).

## 4. Deploy

```sh
npx wrangler deploy
```

It prints the Worker's address, such as
`https://datalog-services.your-subdomain.workers.dev`. That is the **base
URL**. Check it:

```sh
curl https://datalog-services.your-subdomain.workers.dev/v1/capabilities
# {"api_version":"1","features":{"comments":true,"reactions":true,"corrections":true,...}}
```

## 5. Point the site at it

In your site's `_config.yml`:

```yaml
dynamic_services:
  base_url: https://datalog-services.your-subdomain.workers.dev
  api_version: v1
  features:
    comments: true
    reactions: true
    corrections: true

# Comments from your own service rather than Giscus or Disqus.
datalog_plugins:
  enabled:                       # keep the plugins you already list, and add comments
    - datalog-search
    - datalog-comments
  options:
    datalog-comments:
      provider: api
      enabled_by_default: true   # or comments: true on each post that wants them
      moderation: true           # the note under the form says comments are read first
```

Build and publish the site as usual. The theme adds the service to the
Content Security Policy by itself. Reactions and correction reports appear on
every post, and the comments thread appears where comments are on.

That is the whole setup for those three features. `scripts/theme-e2e.js` in
this repository proves it on the theme's own demo: it builds the demo against
the Worker, running locally in the same runtime, then posts a comment,
approves it, reacts and sends a report through a browser.

## 6. Moderate: the inbox and its sign-in

New comments wait for a moderator unless you set `COMMENTS_MODERATION = "false"`.
Correction reports and readers' reports on comments arrive in the same queue.
The theme's moderation page reads that queue. The service decides who may
use it: moderators sign in with GitHub, and the page itself protects nothing.

1. Create a GitHub OAuth app under GitHub → Settings → Developer settings →
   OAuth Apps:
   - Homepage URL: your site.
   - Authorization callback URL: `https://<your base URL>/auth/callback`.
2. Tell the service about it:

   ```toml
   [vars]
   FEATURES = "comments,reactions,corrections,moderation"
   GITHUB_CLIENT_ID = "the app's client id"
   MODERATORS = "your-github-login"          # comma-separated for several
   ```

   ```sh
   npx wrangler secret put GITHUB_CLIENT_SECRET
   npx wrangler deploy
   ```
3. Turn the inbox on in the site's `_config.yml`. Create the page as
   [the theme's moderation guide](https://github.com/DiogoRibeiro7/analytics-blog-jekyll/blob/develop/docs/moderation.md#setup)
   shows, with `moderation_inbox: true`.

   ```yaml
   dynamic_services:
     features:
       moderation: true
   moderation:
     enabled: true
     credentials: include
     sign_in_url: https://<your base URL>/auth/login?return_to=https://your-name.github.io/admin/moderation/
   ```

Anyone can sign in with a GitHub account; only the logins in `MODERATORS` see
the queue. Everyone else is told they may not moderate. Every action is
recorded with the moderator's login and a note.

**The session is a cookie from the service's domain, and that matters.** A
site on `github.io` calling a service on `workers.dev` is cross-site. Browsers
that block third-party cookies (Safari, Firefox in strict mode) then drop the
session, and the inbox keeps asking you to sign in. Chrome and Edge keep it
today.

The durable fix is to give the site and the service the same registrable
domain. With a custom domain for the site (`example.org`), add a
[custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
such as `api.example.org` to the Worker, use it as the base URL, and set:

```toml
COOKIE_DOMAIN = ".example.org"
COOKIE_SAMESITE = "Lax"
CSRF_HEADER = "X-CSRF-Token"
CSRF_COOKIE = "csrf_token"
```

Add the same pair to the site as `dynamic_services.csrf_header: X-CSRF-Token`
and `csrf_cookie: csrf_token`. The site's script can then read the CSRF
cookie and send it back, which is the double-submit protection. Whatever the
domains, a moderation write is refused unless it comes from an origin in
`ALLOWED_ORIGINS`.

## 7. Email: subscriptions and the contact form

Subscriptions send a confirmation email, and the contact form can send you a
copy of each message. Both need a mail provider. The service uses
[Resend](https://resend.com), whose free plan fits a personal site:

1. Create a Resend account, verify the domain you will send from, and create
   an API key.
2. Set:

   ```toml
   [vars]
   FEATURES = "comments,reactions,corrections,contact,subscriptions"
   MAIL_PROVIDER = "resend"
   MAIL_FROM = "Your Name <news@example.org>"
   CONTACT_TO = "you@example.org"                     # where contact messages go
   SUBSCRIPTION_TOPICS = "new-articles,research-notes,datasets"   # as subscriptions.topics lists them
   ```

   ```sh
   npx wrangler secret put RESEND_API_KEY
   npx wrangler deploy
   ```
3. On the site, turn on `contact` and `subscriptions` under
   `dynamic_services.features`, and give the site the page its emails link to,
   as the theme's docs describe: `/subscriptions/`, or set
   `SUBSCRIPTIONS_PAGE`.

The service refuses to start with subscriptions on and no `MAIL_PROVIDER`,
because nobody could ever confirm. Contact messages are stored even without
mail: read them with

```sh
npx wrangler d1 execute DB --remote --command "SELECT created_at, category, name, email, subject, message FROM contact_messages ORDER BY created_at DESC LIMIT 20"
```

Whether an address is already subscribed is not disclosed: a second sign-up
looks like the first, and the subscriber receives their links again. Set
`SUBSCRIPTIONS_DISCLOSE = "true"` to answer "already subscribed" instead.

## 8. Webmentions

Turn on `webmentions` in `FEATURES` and in the site's
`dynamic_services.features`. Then advertise the receiver in the site's
`_config.yml`:

```yaml
webmentions:
  endpoint: https://<your base URL>/webmention
```

Other sites then notify the service. It checks each notification by fetching
the source and confirming the link, and only then shows the mention under
your post, as plain text.

## 9. Spam, abuse and personal data

**Spam controls, on by default:**

- **Rate limits** per reader's address (kept only as a keyed hash):
  - five comments, five reports, three contact messages and five sign-ups per ten minutes;
  - three sign-ups per address per hour;
  - change them with `RATE_LIMITS = "comments=10/600,contact=5/600"`.
- **Comments** wait for a moderator, and hold at most `COMMENTS_MAX_LINKS`
  (2) links. The theme adds a honeypot field that bots fill in and readers
  never see.
- **Readers can report a published comment**, which puts it in the queue.
- **Webmentions** are shown only once their source has been fetched and
  checked.
- **Cloudflare's own tools** can go in front of a custom domain: WAF rules,
  Bot Fight Mode, Turnstile.

**Retention.** A cron trigger runs once a day and deletes what the settings
say. Each is a number of days, and `0` keeps that kind forever:

| Setting | Default | What goes |
| --- | --- | --- |
| `CONTACT_RETENTION_DAYS` | 365 | Contact messages |
| `CORRECTION_RETENTION_DAYS` | 0 | Resolved or rejected correction reports |
| `COMMENT_TRASH_DAYS` | 90 | Comments marked spam or deleted, and reports on them |
| `PENDING_SUBSCRIPTION_DAYS` | 7 | Sign-ups never confirmed |
| `UNSUBSCRIBED_DAYS` | 30 | Subscribers who left, address and all |
| `WEBMENTION_REJECT_DAYS` | 30 | Mentions whose source did not link, or is gone |
| `OUTBOX_DAYS` | 30 | Mail kept by `MAIL_PROVIDER=outbox` (testing only) |

Say what you keep, and for how long, in your site's privacy notice. The
contact form's `contact.retention` setting prints it under the form.

**Deleting a person's data on request.** Most tables hold the address as
written:

```sh
npx wrangler d1 execute DB --remote --command "DELETE FROM subscribers WHERE email = 'reader@example.org'"
npx wrangler d1 execute DB --remote --command "DELETE FROM contact_messages WHERE email = 'reader@example.org'"
npx wrangler d1 execute DB --remote --command "UPDATE corrections SET contact_email = NULL WHERE contact_email = 'reader@example.org'"
```

A comment keeps only a keyed hash of its author's email. Compute it with the
deployment's `SECRET_KEY`, then delete or anonymise the comments that carry
it:

```sh
SECRET_KEY=… node scripts/email-hash.js reader@example.org
npx wrangler d1 execute DB --remote --command "UPDATE comments SET status = 'deleted', author_name = 'Deleted', author_url = NULL, author_email_hash = NULL WHERE author_email_hash = '<the hash>'"
```

`wrangler d1 export DB --remote --output backup.sql` takes a copy of
everything; keep such copies as carefully as the database.

## 10. Check a deployment against the contract

The conformance suite (`conformance/README.md`) checks a deployment the way
the theme uses it. It writes test data and, with its hooks, empties the
database. So run it against a second, test deployment, never the one your
readers use:

```sh
npx wrangler d1 create datalog-services-test
# copy wrangler.toml to wrangler.test.toml, with name = "datalog-services-test" and the new database_id
npx wrangler d1 migrations apply DB --remote --config wrangler.test.toml
npx wrangler secret put SECRET_KEY --config wrangler.test.toml
npx wrangler secret put CONFORMANCE_TOKEN --config wrangler.test.toml
npx wrangler deploy --config wrangler.test.toml
npm run conformance -- --base-url https://datalog-services-test.your-subdomain.workers.dev --origin https://your-name.github.io --hooks-token <the token>
```

Never set `CONFORMANCE_TOKEN` on the deployment your readers use.
`npm run conformance:worker` runs the same suite against the Worker in
`wrangler dev` on your own machine, with nothing deployed.

## Updating

```sh
git pull
npm ci
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

The service reports `api_version` 1, and the theme's
`dynamic_services.api_version` must say the same. When a future version
changes it, the site shows "expect different API versions" rather than failing
silently. That is the moment to update both.

## When something is wrong

| What you see | Why |
| --- | --- |
| The features never appear on the site | `dynamic_services.base_url` is empty, or the feature is off on the site or in `FEATURES` |
| `403 origin_not_allowed` | The page's origin is not in `ALLOWED_ORIGINS`: check `www`, `http` against `https`, and that there is no path or trailing slash |
| "expect different API versions" | The site's `dynamic_services.api_version` is not `v1` |
| `500 misconfigured` | A setting the service cannot run with; `npx wrangler tail` shows the reason |
| The inbox asks to sign in again and again | The session cookie is blocked as third-party: step 6 |
| Every error shows "Reference: req_…" | That id is in the service's logs: `npx wrangler tail`, or the dashboard's Workers logs |
