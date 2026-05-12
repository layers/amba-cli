# `@layers/amba` — the amba CLI

amba is an agent-native backend-as-a-service for mobile apps: functions,
collections, storage, AI gateway, queues, and static sites — one CLI,
per-tenant Postgres + edge runtime.

## Install

```bash
npm install -g @layers/amba
```

…or run on demand:

```bash
npx @layers/amba init
```

## Quick start

```bash
amba init                  # mint a personal dev project and scaffold context
amba login                 # authenticate (browser flow)
amba projects list         # list projects you own
amba projects create --name my-app
```

## Common commands

```bash
amba functions deploy ./functions/hello.ts
amba functions list
amba functions schedule hello "0 * * * *" --tz UTC

amba collections create messages --field user_id:uuid --field body:text
amba collections list
amba types generate                # emit .amba/types.d.ts

amba secrets set OPENAI_KEY --function hello --from-stdin

amba sites deploy ./out --name marketing
amba sites domain add marketing.example.com --site marketing
```

## Headless / CI

Pass a personal access token via `--token <pat>` or the `AMBA_PAT` env
var to skip the browser-based login flow.

## Requirements

- Node.js 22+

## License

Apache-2.0
