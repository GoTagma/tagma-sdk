// Preinstall guard — refuses installation under npm / yarn / pnpm.
// @tagma/sdk ships TypeScript source (main: ./src/sdk.ts) and relies on
// Bun's native .ts loader, so installing under Node-based managers leaves
// users with a broken package.
//
// Bun detection: we can't rely on process.versions.bun alone, because bun
// invokes lifecycle scripts via the interpreter named in the script command
// ("node scripts/preinstall.js" runs under node even when called from bun
// install). Bun does, however, set npm_config_user_agent to a string that
// starts with "bun/<version> ...", which is the canonical cross-manager
// signal. Check both for safety.

const ua = process.env.npm_config_user_agent || '';
if (process.versions.bun || ua.startsWith('bun/') || ua.startsWith('bun ')) {
  process.exit(0);
}

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

process.stderr.write(
  [
    '',
    red(bold('  @tagma/sdk requires Bun (>= 1.3).')),
    '',
    '  This package ships TypeScript source and uses Bun\'s native .ts loader.',
    '  npm / yarn / pnpm cannot consume it.',
    '',
    '  Install with:',
    cyan('    bun add @tagma/sdk'),
    '',
    '  Get Bun: https://bun.sh',
    '',
  ].join('\n') + '\n',
);

process.exit(1);
