# n8n on Cloudflare

Stock n8n, running on Cloudflare's own services instead of a Node server and a database:

| n8n piece | Runs on |
|---|---|
| Editor UI and REST API | Workers, with static assets |
| Database | D1 |
| Execution engine (the stock `WorkflowExecute`) | Durable Objects and Workflows |
| Binary data | R2 |
| Code, Python and Function nodes | Dynamic Workers (`worker_loaders`) |
| Schedule triggers | Cron triggers and a Durable Object |
| MQTT, AMQP, Kafka, IMAP, Postgres and other socket triggers | One Durable Object per trigger, using Workers TCP sockets |

The editor is the stock n8n editor, built from `packages/frontend/editor-ui`. Workflows, credentials and expressions behave as they do in stock n8n.

## Deploy to your own Cloudflare account

You need:

- A Cloudflare account on the Workers Paid plan. Dynamic Workers, Workflows and the 5-minute CPU limit are not on the free plan.
- Node.js 24 or newer, and pnpm (`corepack enable`).

### 1. Build

From the repository root:

```sh
pnpm install
pnpm build
```

That builds the n8n packages, nodes and editor the Worker bundles. The first build takes a while. Then build the Worker:

```sh
cd packages/cloudflare
pnpm build
```

### 2. Deploy

```sh
npx wrangler login
npx wrangler deploy
```

The first deploy creates the D1 database `n8n` and the R2 bucket `n8n-storage` in your account. Later deploys reuse them. Wrangler prints the Worker URL, such as `https://n8n.<your-subdomain>.workers.dev`.

### 3. Create the tables

```sh
npx wrangler d1 migrations apply n8n --remote
```

### 4. Set the encryption key

n8n encrypts stored credentials with this key. Generate one and keep a copy somewhere safe: if it is lost, saved credentials cannot be decrypted.

```sh
openssl rand -hex 32 | npx wrangler secret put N8N_ENCRYPTION_KEY
```

### 5. Open it

Open the Worker URL and create the owner account.

## Update

```sh
git pull
pnpm install && pnpm build
cd packages/cloudflare
pnpm build
npx wrangler d1 migrations apply n8n --remote
npx wrangler deploy
```

## Optional settings

Set these as `vars` in `wrangler.jsonc` or with `npx wrangler secret put`:

| Variable | Meaning |
|---|---|
| `N8N_EDITOR_BASE_URL` | Public URL, if you serve n8n on a custom domain |
| `N8N_DEFAULT_TIMEZONE` | Default timezone for schedules, as in stock n8n |
| `N8N_RATE_LIMIT_DISABLED` | Set to `true` to turn off login rate limits |

To use a custom domain, add a `routes` entry to `wrangler.jsonc` ([docs](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).

## What does not run on Workers

`scripts/unsupported-nodes.mjs` lists the few nodes the editor hides, with the reason for each. Examples are the Execute Command node and the LangChain Code node. Paid n8n features (SSO, source control, log streaming and others) are not included.

## Develop

```sh
pnpm dev                        # wrangler dev, local D1 and R2
pnpm test                       # main, webhook and asset suites
pnpm test:e2e                   # browser tests
pnpm typecheck
```

Each test file starts its own local Worker, so the first run is slow.

## License

The same as the rest of this repository: the n8n [Sustainable Use License](../../LICENSE.md). This package does not use n8n's `.ee.` (enterprise) source files.
