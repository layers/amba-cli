import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pc from 'picocolors';
import { listConfig, setConfig, ApiClientError } from '../api-client.js';

async function getProjectId(cwd: string): Promise<string | null> {
  for (const filename of ['.env.local', '.env']) {
    try {
      const raw = await readFile(join(cwd, filename), 'utf-8');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('AMBA_PROJECT_ID=')) {
          return trimmed.slice('AMBA_PROJECT_ID='.length).trim();
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function requireProjectId(projectId: string | null): asserts projectId is string {
  if (!projectId) {
    console.log(pc.red('  ✗') + ' AMBA_PROJECT_ID not found in .env.local');
    console.log(pc.dim('    Run `amba init` to set up your project'));
    console.log();
    process.exit(1);
  }
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function inferValueType(raw: string): {
  value: unknown;
  value_type: 'string' | 'number' | 'boolean' | 'json';
} {
  // Boolean
  if (raw === 'true') return { value: true, value_type: 'boolean' };
  if (raw === 'false') return { value: false, value_type: 'boolean' };

  // Number
  const num = Number(raw);
  if (!isNaN(num) && raw.trim() !== '') return { value: num, value_type: 'number' };

  // JSON object or array
  if ((raw.startsWith('{') && raw.endsWith('}')) || (raw.startsWith('[') && raw.endsWith(']'))) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return { value: parsed, value_type: 'json' };
    } catch {
      // Fall through to string
    }
  }

  return { value: raw, value_type: 'string' };
}

export async function configListCommand(): Promise<void> {
  const cwd = process.cwd();

  console.log();
  console.log(pc.bold('  amba config list'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  const projectId = await getProjectId(cwd);
  requireProjectId(projectId);

  try {
    const result = await listConfig(projectId);
    const configs = result.data;

    if (configs.length === 0) {
      console.log(pc.dim('  No config values set'));
      console.log(pc.dim('  Use `amba config set <key> <value>` to add one'));
      console.log();
      return;
    }

    // Calculate column widths
    const keyWidth = Math.max(5, ...configs.map((c) => c.key.length));
    const typeWidth = Math.max(4, ...configs.map((c) => c.value_type.length));

    // Header
    console.log(
      pc.dim('  ') +
        pc.bold('Key'.padEnd(keyWidth + 2)) +
        pc.bold('Type'.padEnd(typeWidth + 2)) +
        pc.bold('Value'),
    );
    console.log(pc.dim('  ' + '─'.repeat(keyWidth + typeWidth + 30)));

    // Rows
    for (const config of configs) {
      const valueStr = formatValue(config.value);
      const truncated = valueStr.length > 50 ? valueStr.slice(0, 47) + '...' : valueStr;
      console.log(
        '  ' +
          config.key.padEnd(keyWidth + 2) +
          pc.dim(config.value_type.padEnd(typeWidth + 2)) +
          truncated,
      );
    }

    console.log();
    console.log(pc.dim(`  ${configs.length} config value${configs.length === 1 ? '' : 's'}`));
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError) {
      console.log(pc.red('  ✗') + ` Failed: ${err.message}`);
    } else if (err instanceof Error) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
    console.log();
    process.exit(1);
  }
}

export async function configSetCommand(key: string, rawValue: string): Promise<void> {
  const cwd = process.cwd();

  console.log();
  console.log(pc.bold('  amba config set'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  const projectId = await getProjectId(cwd);
  requireProjectId(projectId);

  const { value, value_type } = inferValueType(rawValue);

  try {
    const result = await setConfig(projectId, { key, value, value_type });

    console.log(pc.green('  ✓') + ` Set ${pc.bold(key)} = ${formatValue(result.data.value)}`);
    console.log(pc.dim(`    Type: ${result.data.value_type}`));
    console.log();
  } catch (err) {
    if (err instanceof ApiClientError) {
      console.log(pc.red('  ✗') + ` Failed: ${err.message}`);
    } else if (err instanceof Error) {
      console.log(pc.red('  ✗') + ` ${err.message}`);
    }
    console.log();
    process.exit(1);
  }
}
