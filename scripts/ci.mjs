import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkManifest } from './check-manifest.mjs';

export function ci(spawn = spawnSync, env = process.env) {
  checkManifest();
  // Use Node directly to avoid platform-specific npm shell shims.
  const verify = spawn(process.execPath, [env.npm_execpath, 'run', 'verify'], {
    stdio: 'inherit',
  });
  if (verify.error || verify.status !== 0)
    throw new Error(
      `Verification failed: ${verify.error?.message ?? verify.status}`,
    );
  const lint = spawn(
    env.ACTIONLINT ?? 'actionlint',
    ['-color', '-shellcheck=', '-pyflakes='],
    {
      stdio: 'inherit',
    },
  );
  if (lint.error?.code === 'ENOENT' && !env.CI) {
    console.log(
      'actionlint not installed; skipped locally. CI requires the pinned binary.',
    );
    return;
  }
  if (lint.error || lint.status !== 0)
    throw new Error(`actionlint failed: ${lint.error?.message ?? lint.status}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  ci();
