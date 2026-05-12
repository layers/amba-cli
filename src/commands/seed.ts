import pc from 'picocolors';
import {
  createSegment,
  createAchievement,
  createContentLibrary,
  addContentItems,
  createXpRule,
  ApiClientError,
} from '../api-client.js';
import { requireProjectId } from '../env.js';

export type SeedPreset = 'starter' | 'gamification' | 'content';

export interface SeedOptions {
  project?: string;
  preset?: SeedPreset;
}

interface SeedResult {
  created: string[];
  skipped: string[];
  failed: Array<{ label: string; error: string }>;
}

async function safeCreate(
  label: string,
  fn: () => Promise<unknown>,
  result: SeedResult,
): Promise<void> {
  try {
    await fn();
    result.created.push(label);
    console.log(pc.green('  ✓') + ` ${label}`);
  } catch (err) {
    if (err instanceof ApiClientError && (err.statusCode === 409 || err.statusCode === 422)) {
      result.skipped.push(label);
      console.log(pc.dim('  -') + ` ${label} ` + pc.dim('(already exists)'));
      return;
    }
    const message = err instanceof Error ? err.message : 'unknown error';
    result.failed.push({ label, error: message });
    console.log(pc.red('  ✗') + ` ${label} — ${message}`);
  }
}

async function seedStarter(projectId: string, result: SeedResult): Promise<void> {
  // A minimal bundle: one segment + one content library + one XP rule.
  await safeCreate(
    'segment: active_users',
    () =>
      createSegment(projectId, {
        name: 'Active Users',
        description: 'Users with at least one session in the last 7 days',
        is_active: true,
        rules: {
          all: [{ property: 'last_seen_at', op: 'gte', value: '7d_ago' }],
        },
      }),
    result,
  );

  await safeCreate(
    'content library: daily_quotes',
    () =>
      createContentLibrary(projectId, {
        slug: 'daily_quotes',
        name: 'Daily Quotes',
        description: 'Sample starter quotes',
      }),
    result,
  );

  await safeCreate(
    'xp rule: session_start +10',
    () =>
      createXpRule(projectId, {
        event_name: 'session_start',
        amount: 10,
        description: 'Award 10 XP for starting a session',
      }),
    result,
  );
}

async function seedGamification(projectId: string, result: SeedResult): Promise<void> {
  await safeCreate(
    'achievement: first_session',
    () =>
      createAchievement(projectId, {
        code: 'first_session',
        name: 'First Session',
        description: 'Complete your first session',
        criteria: { event_name: 'session_start', count: 1 },
        reward: { xp: 50 },
      }),
    result,
  );

  await safeCreate(
    'achievement: streak_7',
    () =>
      createAchievement(projectId, {
        code: 'streak_7',
        name: 'Week Warrior',
        description: 'Maintain a 7-day streak',
        criteria: { streak: 'daily', days: 7 },
        reward: { xp: 250 },
      }),
    result,
  );

  await safeCreate(
    'xp rule: session_complete +20',
    () =>
      createXpRule(projectId, {
        event_name: 'session_complete',
        amount: 20,
        description: 'Award 20 XP for completing a session',
      }),
    result,
  );

  await safeCreate(
    'xp rule: share_action +15',
    () =>
      createXpRule(projectId, {
        event_name: 'share_action',
        amount: 15,
        description: 'Award 15 XP for sharing',
      }),
    result,
  );
}

async function seedContent(projectId: string, result: SeedResult): Promise<void> {
  let libraryId: string | null = null;
  await safeCreate(
    'content library: affirmations',
    async () => {
      const res = await createContentLibrary(projectId, {
        slug: 'affirmations',
        name: 'Affirmations',
        description: 'Sample daily affirmations',
      });
      libraryId = res.data.id;
    },
    result,
  );

  if (libraryId) {
    await safeCreate(
      'content items x3',
      () =>
        addContentItems(projectId, libraryId as unknown as string, {
          items: [
            { key: 'aff_1', content: { text: 'You are capable of amazing things.' } },
            { key: 'aff_2', content: { text: 'Every step forward counts.' } },
            { key: 'aff_3', content: { text: 'Today is a fresh start.' } },
          ],
        }),
      result,
    );
  }
}

export async function seedCommand(opts: SeedOptions = {}): Promise<void> {
  const cwd = process.cwd();
  const projectId = await requireProjectId(cwd, opts.project);
  const preset: SeedPreset = opts.preset ?? 'starter';

  console.log();
  console.log(pc.bold(`  amba seed --preset=${preset}`));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();
  console.log(pc.dim(`  Project: ${projectId}`));
  console.log();

  const result: SeedResult = { created: [], skipped: [], failed: [] };

  switch (preset) {
    case 'starter':
      await seedStarter(projectId, result);
      break;
    case 'gamification':
      await seedGamification(projectId, result);
      break;
    case 'content':
      await seedContent(projectId, result);
      break;
    default:
      console.log(pc.red('  ✗') + ` Unknown preset: ${preset as string}`);
      console.log(pc.dim('    Valid: starter, gamification, content'));
      console.log();
      process.exit(1);
  }

  console.log();
  console.log(
    pc.dim(
      `  ${result.created.length} created · ${result.skipped.length} skipped · ${result.failed.length} failed`,
    ),
  );
  console.log();

  if (result.failed.length > 0) {
    process.exit(1);
  }
}
