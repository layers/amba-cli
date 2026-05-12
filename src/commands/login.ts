import pc from 'picocolors';
import { browserAuthFlow, storeCredentials } from '../auth.js';

export async function loginCommand(): Promise<void> {
  console.log();
  console.log(pc.bold('  amba login'));
  console.log(pc.dim('  ─────────────────────────────────'));
  console.log();

  try {
    const creds = await browserAuthFlow();
    await storeCredentials(creds);

    console.log(pc.green('  ✓') + ' Authenticated successfully');
    console.log(pc.dim('    Credentials saved to ~/.amba/credentials.json'));
    console.log();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.log(pc.red('  ✗') + ` Authentication failed: ${message}`);
    console.log();
    process.exit(1);
  }
}
