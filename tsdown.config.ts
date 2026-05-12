import { defineConfig } from 'tsdown';

/**
 * Build config for the publishable `amba` CLI. The CLI ships to npm as
 * a self-contained binary — `npx amba init` is the first command every
 * customer runs. Only third-party packages declared in
 * `package.json#dependencies` stay external; everything else is inlined.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  // Inline workspace-style deps when present so the published binary is
  // self-contained. (The CLI no longer has any `@layers/amba-*` runtime
  // deps; this is here for defense-in-depth.)
  noExternal: [/^@layers\/amba-/],
  // Strip unused exports from the inlined deps.
  treeshake: true,
  sourcemap: false,
});
