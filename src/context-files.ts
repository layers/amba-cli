import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

interface ContextFileOptions {
  projectId: string;
  projectName: string;
  apiKey: string;
  framework: 'expo' | 'react-native' | 'web' | 'unknown';
  cwd: string;
}

/**
 * Generate AMBA.md project context file for AI agents.
 */
function generateAmbaMarkdown(opts: ContextFileOptions): string {
  const sdkPackage = opts.framework === 'expo' ? '@layers/amba-expo' : '@layers/amba-client'; // react-native + web + unknown all use the core SDK

  const providerExample =
    opts.framework === 'expo'
      ? `
### Client Setup

\`\`\`tsx
// app/_layout.tsx
import { useEffect } from 'react';
import { Slot } from 'expo-router';
import { Amba } from '@layers/amba-expo';

export default function RootLayout() {
  useEffect(() => {
    Amba.init({
      projectId: process.env.EXPO_PUBLIC_AMBA_PROJECT_ID!,
      apiKey: process.env.EXPO_PUBLIC_AMBA_API_KEY!,
    });
  }, []);

  return <Slot />;
}
\`\`\`

### Using the Client

\`\`\`tsx
import { Amba } from '@layers/amba-expo';

export default function MyComponent() {
  const onPress = async () => {
    // Track an event
    await Amba.track('lesson_completed', { lesson_id: '123' });

    // Sign in with Apple (requires expo-apple-authentication)
    await Amba.signInWithApple();

    // Read remote config
    const showBanner = Amba.configModule.get('show_promo_banner');

    // Read current streaks
    const streaks = await Amba.streaks.getAll();
  };

  // ...
}
\`\`\``
      : `
### Client Setup

\`\`\`typescript
import { Amba } from '@layers/amba-client';

Amba.configure({
  projectId: process.env.AMBA_PROJECT_ID!,
  apiKey: process.env.AMBA_API_KEY!,
});

await Amba.client.init();

// Track an event
await Amba.client.track('page_viewed', { page: '/pricing' });

// Get remote config
const config = Amba.client.config.get('feature_flags');

// Auth
await Amba.client.auth.signUpWithEmail('user@example.com', 'hunter2');
\`\`\``;

  return `# Amba Project Context

> This file provides context about the Amba integration for AI coding agents.

## Project Info

| Key | Value |
|-----|-------|
| Project ID | \`${opts.projectId}\` |
| Project Name | ${opts.projectName} |
| Framework | ${opts.framework} |
| SDK | \`${sdkPackage}\` |

## Environment Variables

These are configured in \`.env.local\`:

- \`AMBA_PROJECT_ID\` — Your project identifier
- \`AMBA_API_KEY\` — Client API key (safe for client-side use)
- \`AMBA_API_URL\` — API endpoint (defaults to https://api.amba.dev)

## SDK Usage
${providerExample}

## Available Features

- **Push Notifications** — Send targeted push notifications to user segments
- **Remote Config** — Key-value configuration that updates without app releases
- **Segments** — Group users by behavior, properties, or entitlements
- **Streaks** — Track user engagement streaks (daily, weekly)
- **Content Libraries** — Scheduled content delivery (daily tips, weekly challenges)
- **Entitlements** — Subscription status via RevenueCat integration
- **Analytics** — DAU, MAU, retention, and custom event tracking

## API Reference

- Admin API: \`https://api.amba.dev/v1/admin\`
- Client API: \`https://api.amba.dev/v1/client\`
- Docs: \`https://docs.amba.dev\`

## CLI Commands

\`\`\`bash
amba status          # Check project health
amba push test       # Send a test push notification
amba config list     # List remote config values
amba config set <key> <value>  # Set a config value
\`\`\`
`;
}

/**
 * Generate .cursor/rules/amba.mdc Cursor rules file.
 */
function generateCursorRules(opts: ContextFileOptions): string {
  const sdk = opts.framework === 'expo' ? '@layers/amba-expo' : '@layers/amba-client';

  return `---
description: Rules for working with the Amba SDK in this project
globs: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]
---

# Amba SDK Rules

## Project Setup
- Project ID: \`${opts.projectId}\`
- SDK: \`${sdk}\`
- API URL: \`https://api.amba.dev\`

## Environment Variables
- Always read Amba config from environment variables, never hardcode
- Use \`process.env.AMBA_PROJECT_ID\` and \`process.env.AMBA_API_KEY\`
- The .env.local file contains the project credentials

## SDK Patterns
${
  opts.framework === 'expo'
    ? `- Import the \`Amba\` singleton from \`@layers/amba-expo\`
- Call \`Amba.init({ projectId, apiKey })\` once in the root layout (inside a \`useEffect\`)
- The Expo wrapper auto-wires AsyncStorage, push tokens, and Apple/Google sign-in
- Use \`Amba.signInWithApple()\` / \`Amba.signInWithGoogle()\` for social auth one-liners
- Call \`Amba.track()\` for engagement events, don't build custom analytics`
    : `- Initialize the Amba client once and export it as a singleton
- Use \`Amba.client.track()\` for all engagement events
- Use \`Amba.client.config.get()\` for remote configuration
- Use \`Amba.client.auth\` for sign-up / sign-in flows`
}

## Push Notifications
- Register push tokens via the SDK \`registerPushToken()\` method
- Handle notification payloads using the SDK's notification listener
- Don't implement custom push token management

## Remote Config
- Use remote config for feature flags and dynamic values
- Always provide sensible defaults when reading config values
- Config values are cached — don't fetch on every render

## Streaks
- Streaks are server-managed; the SDK provides read-only access
- Use \`track()\` to record qualifying events — the server evaluates streaks
- Show streak state from \`streak.current()\`, don't calculate manually

## Best Practices
- Don't store Amba API keys in source code or commit them to git
- Use \`.env.local\` for local development credentials
- The client API key (prefixed \`amb_dev_ck_\` or \`amb_live_ck_\`) is safe for client-side use
- Server keys (prefixed \`amb_dev_sk_\` or \`amb_live_sk_\`) must stay server-side only
`;
}

/**
 * Write both context files to the project directory.
 */
export async function generateContextFiles(opts: ContextFileOptions): Promise<string[]> {
  const files: string[] = [];

  // Write AMBA.md
  const ambaPath = join(opts.cwd, 'AMBA.md');
  await writeFile(ambaPath, generateAmbaMarkdown(opts), 'utf-8');
  files.push('AMBA.md');

  // Write .cursor/rules/amba.mdc
  const cursorDir = join(opts.cwd, '.cursor', 'rules');
  await mkdir(cursorDir, { recursive: true });
  const cursorPath = join(cursorDir, 'amba.mdc');
  await writeFile(cursorPath, generateCursorRules(opts), 'utf-8');
  files.push('.cursor/rules/amba.mdc');

  return files;
}
