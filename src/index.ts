#!/usr/bin/env node

import { Command } from 'commander';
import pc from 'picocolors';
import { initCommand } from './commands/init.js';
import { loginCommand } from './commands/login.js';
import { statusCommand } from './commands/status.js';
import { pushTestCommand } from './commands/push.js';
import { configListCommand, configSetCommand } from './commands/config.js';
import {
  projectsListCommand,
  projectsCreateCommand,
  projectsShowCommand,
  projectsDeleteCommand,
} from './commands/projects.js';
import { logsTailCommand } from './commands/logs.js';
import { seedCommand, type SeedPreset } from './commands/seed.js';
import { dbMigrateCommand } from './commands/db.js';
import { analyticsExportCommand, type AnalyticsType } from './commands/analytics.js';
import { schemaExportCommand, type SchemaDomain, type SchemaFormat } from './commands/schema.js';
import {
  functionsConsumeCommand,
  functionsConsumersListCommand,
  functionsConsumersUnbindCommand,
  functionsDeployCommand,
  functionsListCommand,
  functionsDeleteCommand,
  functionsScheduleCommand,
  functionsDevCommand,
} from './commands/functions.js';
import { functionsLogsCommand } from './commands/functions-logs.js';
import { secretsSetCommand, secretsListCommand, secretsUnsetCommand } from './commands/secrets.js';
import {
  aiProvidersAddCommand,
  aiProvidersDeleteCommand,
  aiProvidersListCommand,
} from './commands/ai.js';
import {
  collectionsCreateCommand,
  collectionsAlterCommand,
  collectionsListCommand,
  collectionsDropCommand,
} from './commands/collections.js';
import { typesGenerateCommand } from './commands/types.js';
import {
  sitesArchiveCommand,
  sitesDeployCommand,
  sitesDisableCommand,
  sitesDomainAddCommand,
  sitesDomainListCommand,
  sitesDomainRemoveCommand,
  sitesEnableCommand,
  sitesListCommand,
  sitesLogsCommand,
  sitesRollbackCommand,
} from './commands/sites.js';
import { clearCredentials, resolveTokenSource, setBearerOverride } from './auth.js';

const program = new Command();

program
  .name('amba')
  .description('amba — agent-native backend-as-a-service for mobile apps.')
  .version('0.1.0');

// ─── Global --token / AMBA_PAT ─────────────────────────────────────────
//
// Headless-auth fallback. Every command honors `--token <pat>` or the
// `AMBA_PAT` env var without needing a browser-driven login. Resolution
// precedence: --token flag > AMBA_PAT env > stored creds. The flag is
// declared at the top-level `program` and inherits to every subcommand
// via commander's `optsWithGlobals`. We thread the resolved value into
// the api-client BEFORE any subcommand action runs — `preAction` fires
// once per invocation, after option parsing but before the handler.
//
// We don't include `--token` in `--help` redactable form; that's
// commander's default for global options. Operators who copy-paste a
// command line with their PAT into a chat message expose it the same
// way they would `--api-key` or `-H "Authorization: Bearer ..."` —
// flagged in the gap-doc as "tokens in argv are visible to other
// processes on shared hosts" but the convenience wins for agents.

program.option(
  '--token <pat>',
  'Use a Personal Access Token for headless / CI / agent use (overrides ~/.amba/credentials.json + AMBA_PAT env)',
);

program.hook('preAction', (thisCommand) => {
  // `optsWithGlobals` walks up the command tree so subcommand handlers
  // see the top-level `--token` regardless of where it was placed on
  // the command line.
  const opts = thisCommand.optsWithGlobals<{ token?: string }>();
  const resolved = resolveTokenSource({
    flagToken: opts.token,
    envToken: process.env['AMBA_PAT'],
  });
  setBearerOverride(resolved);
});

function runAction(fn: () => Promise<void>): Promise<void> {
  return fn().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(pc.red(`\n  Error: ${message}\n`));
    process.exit(1);
  });
}

// ─── init ────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Initialize Amba in the current project (mints a personal dev project by default)')
  .option('--with-example', 'Scaffold a sample app.tsx + README snippet into the current directory')
  .option('--env <env>', "'development' (default) or 'production'")
  .action(async (opts: { withExample?: boolean; env?: string }) => {
    let env: 'development' | 'production' | undefined;
    if (opts.env === 'development' || opts.env === 'dev') env = 'development';
    else if (opts.env === 'production' || opts.env === 'prod') env = 'production';
    else if (opts.env !== undefined) {
      console.error(`Error: --env must be 'development' or 'production' (got '${opts.env}').`);
      process.exit(1);
    }
    await runAction(() => initCommand({ withExample: opts.withExample, env }));
  });

// ─── login ───────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with Amba')
  .action(async () => {
    await runAction(loginCommand);
  });

// ─── logout ──────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear stored credentials')
  .action(async () => {
    await runAction(async () => {
      await clearCredentials();
      console.log();
      console.log(pc.green('  ✓') + ' Logged out — credentials removed');
      console.log();
    });
  });

// ─── status ──────────────────────────────────────────────────────────

program
  .command('status')
  .description('Show project health and integration status')
  .option('--detailed', 'Include integrations, user count, and segment summary')
  .action(async (opts: { detailed?: boolean }) => {
    await runAction(() => statusCommand({ detailed: opts.detailed }));
  });

// ─── push ────────────────────────────────────────────────────────────

const push = program.command('push').description('Push notification commands');

push
  .command('test')
  .description('Send a test push notification to all registered devices')
  .action(async () => {
    await runAction(pushTestCommand);
  });

// ─── config ──────────────────────────────────────────────────────────

const config = program.command('config').description('Remote config commands');

config
  .command('list')
  .description('List all remote config values')
  .action(async () => {
    await runAction(configListCommand);
  });

config
  .command('set <key> <value>')
  .description('Set a remote config value')
  .action(async (key: string, value: string) => {
    await runAction(() => configSetCommand(key, value));
  });

// ─── projects ────────────────────────────────────────────────────────

const projects = program.command('projects').description('Project management commands');

projects
  .command('list')
  .description('List all projects in the authenticated developer account')
  .action(async () => {
    await runAction(projectsListCommand);
  });

projects
  .command('create')
  .description('Create a new project')
  .requiredOption('--name <name>', 'Project name')
  .option('--env <env>', 'Environment hint (informational; projects start in development)')
  .option('--bundle-id <id>', 'Bundle identifier (iOS/Android)')
  .option('--platform <platform>', "Platform: 'ios' | 'android' | 'all'")
  .action(async (opts: { name: string; env?: string; bundleId?: string; platform?: string }) => {
    await runAction(() =>
      projectsCreateCommand({
        name: opts.name,
        env: opts.env,
        bundleId: opts.bundleId,
        platform: opts.platform,
      }),
    );
  });

projects
  .command('show <projectId>')
  .description('Show full project details as JSON')
  .action(async (projectId: string) => {
    await runAction(() => projectsShowCommand(projectId));
  });

projects
  .command('delete <projectId>')
  .description('Delete a project (irreversible)')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (projectId: string, opts: { yes?: boolean }) => {
    await runAction(() => projectsDeleteCommand(projectId, { yes: opts.yes }));
  });

// ─── logs ────────────────────────────────────────────────────────────

const logs = program.command('logs').description('Log streaming commands');

logs
  .command('tail')
  .description('Tail the engagement event log for a project')
  .option('--project <id>', 'Project id (overrides .env.local)')
  .option('--follow', 'Keep the stream open and poll for new events every 2s')
  .option('--json', 'Emit raw NDJSON for piping (no decoration)')
  .option('--since <iso>', 'Only show events on or after this ISO 8601 timestamp')
  .option('--event-name <name>', 'Filter to a single event_name')
  .option('--user-id <id>', 'Filter to a single app_user_id')
  .option('--limit <n>', 'Max events per page (default 100, max 1000)', (v) => parseInt(v, 10))
  .action(
    async (opts: {
      project?: string;
      follow?: boolean;
      json?: boolean;
      since?: string;
      eventName?: string;
      userId?: string;
      limit?: number;
    }) => {
      await runAction(() =>
        logsTailCommand({
          project: opts.project,
          follow: opts.follow,
          json: opts.json,
          since: opts.since,
          eventName: opts.eventName,
          userId: opts.userId,
          limit: opts.limit,
        }),
      );
    },
  );

// ─── seed ────────────────────────────────────────────────────────────

program
  .command('seed')
  .description('Populate test data for the current project')
  .option('--project <id>', 'Project id (overrides .env.local)')
  .option('--preset <preset>', "Preset: 'starter' | 'gamification' | 'content'", 'starter')
  .action(async (opts: { project?: string; preset?: string }) => {
    await runAction(() =>
      seedCommand({
        project: opts.project,
        preset: (opts.preset ?? 'starter') as SeedPreset,
      }),
    );
  });

// ─── db ──────────────────────────────────────────────────────────────

const db = program.command('db').description('Database operations');

db.command('migrate')
  .description('Run tenant migrations')
  .option('--project <id>', 'Project id (overrides .env.local)')
  .action(async (opts: { project?: string }) => {
    await runAction(() => dbMigrateCommand({ project: opts.project }));
  });

// ─── analytics ───────────────────────────────────────────────────────

const analytics = program.command('analytics').description('Analytics export commands');

analytics
  .command('export')
  .description('Export users or events to CSV or NDJSON')
  .requiredOption('--type <type>', "'users' | 'events'")
  .option('--project <id>', 'Project id (overrides .env.local)')
  .option('--since <date>', 'Only include rows since this ISO 8601 timestamp')
  .option('--until <date>', 'Only include rows up to this ISO 8601 timestamp')
  .option('--out <file>', 'Write output to file instead of stdout')
  .option('--format <fmt>', "'csv' (default) | 'ndjson'")
  .option('--limit <n>', 'Per-page row limit when paginating events', (v) => parseInt(v, 10))
  .action(
    async (opts: {
      type: string;
      project?: string;
      since?: string;
      until?: string;
      out?: string;
      format?: string;
      limit?: number;
    }) => {
      await runAction(() =>
        analyticsExportCommand({
          type: opts.type as AnalyticsType,
          project: opts.project,
          since: opts.since,
          until: opts.until,
          out: opts.out,
          format: opts.format as 'csv' | 'ndjson' | undefined,
          limit: opts.limit,
        }),
      );
    },
  );

// ─── schema ──────────────────────────────────────────────────────────

const schema = program.command('schema').description('Schema export commands');

schema
  .command('export')
  .description('Dump schema definitions for domains')
  .requiredOption(
    '--domain <domain>',
    "Domain: 'all' | 'achievements' | 'streaks' | 'xp' | 'leaderboards' | 'challenges' | 'content' | 'segments' | 'push'",
  )
  .option('--format <format>', "'json' | 'typescript'", 'json')
  .action(async (opts: { domain: string; format?: string }) => {
    await runAction(() =>
      schemaExportCommand({
        domain: opts.domain as SchemaDomain,
        format: (opts.format ?? 'json') as SchemaFormat,
      }),
    );
  });

// ─── functions (v2) ──────────────────────────────────────────────────

const functions = program
  .command('functions')
  .description('Customer Worker functions (Cloudflare Workers for Platforms)');

functions
  .command('deploy <file>')
  .description('Bundle a function file and deploy to the dispatch namespace')
  .option('--name <name>', 'Function name (default: filename without extension)')
  .option('--dry-run', 'Bundle and report size without uploading')
  // Per-function rate-limit. All three flags must be provided together
  // (or all omitted = no rate limit). Enforced at the edge pre-dispatch.
  .option('--rate-limit-window <duration>', 'Rate-limit window: 60s | 5m | 1h')
  .option('--rate-limit-max <int>', 'Rate-limit max requests per window', (v) =>
    Number.parseInt(v, 10),
  )
  .option('--rate-limit-key <kind>', 'Rate-limit bucket key: user_id | ip')
  .action(
    async (
      file: string,
      opts: {
        name?: string;
        dryRun?: boolean;
        rateLimitWindow?: string;
        rateLimitMax?: number;
        rateLimitKey?: string;
      },
    ) => {
      await runAction(() => functionsDeployCommand(file, opts));
    },
  );

functions
  .command('list')
  .description('List active functions for the current project')
  .action(async () => {
    await runAction(functionsListCommand);
  });

functions
  .command('delete <name>')
  .description('Disable + remove a function from the dispatch namespace')
  .action(async (name: string) => {
    await runAction(() => functionsDeleteCommand(name));
  });

functions
  .command('schedule <name> <cron>')
  .description('Register a cron schedule that invokes a deployed function')
  .option('--tz <iana>', 'IANA timezone for the schedule (default: UTC)')
  .action(async (name: string, cron: string, opts: { tz?: string }) => {
    await runAction(() => functionsScheduleCommand(name, cron, opts));
  });

functions
  .command('dev <file>')
  .description('Run wrangler dev --remote against your dev project')
  .action(async (file: string) => {
    await runAction(() => functionsDevCommand(file));
  });

functions
  .command('logs <name>')
  .description('Stream log events for a deployed function')
  .option('--since <iso>', 'Start of the time range (default: 1 hour ago)')
  .option('--until <iso>', 'End of the time range (default: now). Ignored on --tail.')
  .option('--limit <n>', 'Max events per fetch (default 100, max 1000)', (v) => parseInt(v, 10))
  // Both `--tail` and `--follow` are accepted; the body normalizes via
  // `tail || follow`. Aliasing keeps both spellings working.
  .option('--tail', 'Follow new events; polls every 3s. Ctrl+C to stop.')
  .option('--follow', 'Alias for --tail (kept for backwards compatibility with v1 log commands).')
  .option('--json', 'NDJSON output to stdout (one event per line)')
  .action(
    async (
      name: string,
      opts: {
        since?: string;
        until?: string;
        limit?: number;
        tail?: boolean;
        follow?: boolean;
        json?: boolean;
      },
    ) => {
      await runAction(() =>
        functionsLogsCommand(name, {
          since: opts.since,
          until: opts.until,
          limit: opts.limit,
          // Either flag enables tail mode; both being set is a no-op
          // duplication, not an error (commander already gives us
          // `tail: true, follow: true`).
          tail: opts.tail || opts.follow,
          json: opts.json,
        }),
      );
    },
  );

functions
  .command('consume <queue-name> <function-name>')
  .description('Bind a function as the consumer for a queue')
  .option('--paused', 'Create the binding paused (the workflow DLQs payloads until resumed)')
  .action(async (queueName: string, functionName: string, opts: { paused?: boolean }) => {
    await runAction(() => functionsConsumeCommand(queueName, functionName, opts));
  });

const consumers = functions
  .command('consumers')
  .description('Manage queue → function bindings');

consumers
  .command('list')
  .description('List queue bindings for the current project')
  .action(async () => {
    await runAction(functionsConsumersListCommand);
  });

consumers
  .command('unbind <queue-name>')
  .description('Remove the binding for a queue (DROP)')
  .action(async (queueName: string) => {
    await runAction(() => functionsConsumersUnbindCommand(queueName));
  });

// ─── secrets (v2) ────────────────────────────────────────────────────

const secrets = program
  .command('secrets')
  .description('Function secrets (GCP canonical, Workers-Secret synced)');

secrets
  // The positional `value` arg is OPTIONAL when `--from-stdin` is used —
  // commander treats `[value]` as optional, and the command body resolves
  // via `resolveSecretValue` which throws if neither is supplied.
  .command('set <name> [value]')
  .description(
    'Write a secret to GCP Secret Manager and queue Workers Secret sync. ' +
      'Use --from-stdin to keep the value out of shell history.',
  )
  .requiredOption(
    '--function <name>',
    "Function name the secret binds to. Secrets are scoped per dispatched script — there is no project-wide secret in v1; every secret belongs to exactly one function. Use the same name as the entry passed to 'amba functions deploy'.",
  )
  .option(
    '--env <env>',
    "'dev' | 'prod' — INFORMATIONAL ONLY. Both share one secret namespace per project. Use distinct secret names (e.g. STRIPE_KEY_DEV / STRIPE_KEY_PROD) or two amba projects for real env isolation.",
  )
  .option(
    '--from-stdin',
    'Read the secret value from stdin instead of the positional arg. Mutually exclusive with <value>. Pipe in: `echo $KEY | amba secrets set NAME --function fn --from-stdin`.',
  )
  .action(
    async (
      name: string,
      value: string | undefined,
      opts: { function: string; env?: string; fromStdin?: boolean },
    ) => {
      await runAction(() =>
        secretsSetCommand(name, value, {
          function: opts.function,
          env: (opts.env as 'dev' | 'prod' | undefined) ?? 'dev',
          fromStdin: opts.fromStdin,
        }),
      );
    },
  );

secrets
  .command('list')
  .description('List secret sync status for the current project')
  .action(async () => {
    await runAction(secretsListCommand);
  });

secrets
  .command('unset <name>')
  .description('Remove a secret from GCP Secret Manager (Workers Secret cleared on next deploy)')
  .requiredOption('--function <name>', 'Function name the secret binds to')
  .action(async (name: string, opts: { function: string }) => {
    await runAction(() => secretsUnsetCommand(name, opts));
  });

// ─── collections (v2) ────────────────────────────────────────────────

const collections = program
  .command('collections')
  .description('Customer collections (schema-first Postgres in tenant Neon)');

collections
  .command('create <name>')
  .description('Create a collection with the given fields')
  .option(
    '--field <spec>',
    'Field spec: name:type[:nullable] (e.g. user_id:uuid, parsed:jsonb:nullable). Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option(
    '--index <spec>',
    'Index spec: "col1 [asc|desc], col2 [asc|desc]". Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .action(async (name: string, opts: { field: string[]; index: string[] }) => {
    await runAction(() => collectionsCreateCommand(name, opts));
  });

collections
  .command('alter <name>')
  .description('Add columns / indexes or drop columns on an existing collection')
  .option(
    '--add-field <spec>',
    'Column to add (name:type[:nullable]). Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option(
    '--add-index <spec>',
    'Index to add ("col [asc|desc], …"). Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option(
    '--drop-field <name>',
    'Column to drop (DESTRUCTIVE — requires --confirm <name>). Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .option(
    '--confirm <name>',
    'Confirm a destructive --drop-field <name>. Repeatable.',
    (val: string, prev: string[]) => [...(prev ?? []), val],
    [] as string[],
  )
  .action(
    async (
      name: string,
      opts: {
        addField: string[];
        addIndex: string[];
        dropField: string[];
        confirm: string[];
      },
    ) => {
      await runAction(() => collectionsAlterCommand(name, opts));
    },
  );

collections
  .command('list')
  .description('List collections for the current project')
  .action(async () => {
    await runAction(collectionsListCommand);
  });

collections
  .command('drop <name>')
  .description('Drop a collection (DESTRUCTIVE — requires --confirm <name>)')
  .option('--confirm <name>', 'Pass the collection name to confirm the drop')
  .action(async (name: string, opts: { confirm?: string }) => {
    await runAction(() => collectionsDropCommand(name, opts));
  });

// ─── types ───────────────────────────────────────────────────────────

const types = program.command('types').description('TypeScript codegen for collections');

types
  .command('generate')
  .description('Emit .amba/types.d.ts from the current collection schemas')
  .option('--out <path>', 'Output path (default: .amba/types.d.ts)')
  .option('--watch', 'Re-emit every 5s on schema changes')
  .action(async (opts: { out?: string; watch?: boolean }) => {
    await runAction(() => typesGenerateCommand(opts));
  });

// ─── sites ────────────────────────────────────────────────────────────

const sites = program
  .command('sites')
  .description('Static site hosting');

sites
  .command('deploy <dir>')
  .description('Upload a built static-site directory to Pages-for-Platforms')
  .option('--name <name>', 'Site name (default: basename of dir, slug-cleaned)')
  .option('--dry-run', 'Scan + size-check without uploading')
  .action(async (dir: string, opts: { name?: string; dryRun?: boolean }) => {
    await runAction(() => sitesDeployCommand(dir, opts));
  });

sites
  .command('list')
  .description('List sites for the current project')
  .action(async () => {
    await runAction(sitesListCommand);
  });

sites
  .command('logs <name>')
  .description('List recent CF Pages deployments for a site')
  .action(async (name: string) => {
    await runAction(() => sitesLogsCommand(name));
  });

sites
  .command('rollback <name>')
  .description('Roll back a site to a previous deployment (default: previous successful)')
  .option('--to <deployment_id>', 'Specific deployment id to roll back to')
  .action(async (name: string, opts: { to?: string }) => {
    await runAction(() => sitesRollbackCommand(name, opts));
  });

sites
  .command('disable <name>')
  .description('Disable a site (control-plane only — CF Pages project remains)')
  .action(async (name: string) => {
    await runAction(() => sitesDisableCommand(name));
  });

sites
  .command('enable <name>')
  .description('Re-enable a previously disabled site')
  .action(async (name: string) => {
    await runAction(() => sitesEnableCommand(name));
  });

sites
  .command('archive <name>')
  .description('Archive a site (DESTRUCTIVE — deletes CF Pages project + custom hostnames)')
  .option('--confirm <name>', 'Pass the site name to confirm')
  .action(async (name: string, opts: { confirm?: string }) => {
    await runAction(() => sitesArchiveCommand(name, opts));
  });

const sitesDomain = sites.command('domain').description('Manage custom hostnames per site');

sitesDomain
  .command('add <hostname>')
  .description('Attach a custom hostname (CF for SaaS — DV cert, polls until active)')
  .requiredOption('--site <name>', 'Site name to attach the hostname to')
  .option('--zone-id <id>', 'CF zone id (default: env CLOUDFLARE_AMBA_HOST_ZONE_ID)')
  .option('--no-wait', 'Skip the cert-status poll loop; return as soon as the row is recorded')
  .option('--timeout <seconds>', 'Cert poll timeout (default 600)', (v) => parseInt(v, 10))
  .action(
    async (
      hostname: string,
      opts: { site: string; zoneId?: string; noWait?: boolean; timeout?: number },
    ) => {
      await runAction(() =>
        sitesDomainAddCommand(hostname, {
          site: opts.site,
          zoneId: opts.zoneId,
          noWait: opts.noWait,
          timeout: opts.timeout,
        }),
      );
    },
  );

sitesDomain
  .command('list <site>')
  .description('List custom hostnames attached to a site')
  .action(async (site: string) => {
    await runAction(() => sitesDomainListCommand(site));
  });

sitesDomain
  .command('remove <hostname>')
  .description('Detach a custom hostname (best-effort CF detach + control-plane row delete)')
  .requiredOption('--site <name>', 'Site name the hostname is attached to')
  .option('--zone-id <id>', 'CF zone id (default: env CLOUDFLARE_AMBA_HOST_ZONE_ID)')
  .action(async (hostname: string, opts: { site: string; zoneId?: string }) => {
    await runAction(() =>
      sitesDomainRemoveCommand(hostname, { site: opts.site, zoneId: opts.zoneId }),
    );
  });

// ─── ai providers ─────────────────────────────────────────────────────

const ai = program.command('ai').description('AI gateway — manage provider keys + prompts');

const aiProviders = ai
  .command('providers')
  .description('Per-project provider key registration (Anthropic, OpenAI)');

aiProviders
  .command('add <provider>')
  .description(
    'Register an AI provider key. Plaintext stored securely server-side; ' +
      'a preview (first-6+last-4) is printed back. Use --from-stdin to ' +
      'keep the key out of shell history.',
  )
  .option('--key <value>', 'Provider API key plaintext (alternative: --from-stdin)')
  .option('--from-stdin', 'Read the key from stdin instead of --key')
  .action(async (provider: string, opts: { key?: string; fromStdin?: boolean }) => {
    await runAction(() => aiProvidersAddCommand(provider, opts));
  });

aiProviders
  .command('list')
  .description('List registered AI providers for the current project')
  .action(async () => {
    await runAction(aiProvidersListCommand);
  });

aiProviders
  .command('delete <provider>')
  .description('Remove a provider registration (refuses if active prompts reference it)')
  .action(async (provider: string) => {
    await runAction(() => aiProvidersDeleteCommand(provider));
  });

program.parse();
