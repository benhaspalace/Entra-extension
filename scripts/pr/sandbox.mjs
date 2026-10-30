import {
  copyFileSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { git, run } from '../harness/process.mjs';
import { loadLocalConfig } from '../harness/config.mjs';

// Loaded with the orchestrator, not from package.json on the checked-out branch.
const GATE = [
  'cp -R /input/. /workspace/',
  'cd /workspace',
  // Keep the dependency root writable for tool caches, not the image packages.
  'mkdir node_modules',
  'for dependency in /opt/node_modules/*; do ln -s "$dependency" node_modules/ || exit; done',
  'node scripts/build.mjs',
  'node node_modules/vitest/vitest.mjs run',
  'node node_modules/eslint/bin/eslint.js .',
  'node node_modules/typescript/bin/tsc --noEmit',
].join(' && ');

export function verifyInSandbox() {
  const image = process.env.PR_GATE_IMAGE ?? loadLocalConfig().prGateImage;
  if (
    typeof image !== 'string' ||
    !/^(?:[a-zA-Z0-9][a-zA-Z0-9./:_-]*@)?sha256:[a-f0-9]{64}$/.test(image)
  )
    throw new Error(
      'Set PR_GATE_IMAGE or local prGateImage to a trusted, digest-pinned Linux image with Node and dependencies in /opt/node_modules (npm run gate:image); host execution is disabled.',
    );
  const root = resolve(process.cwd());
  const directory = mkdtempSync(join(tmpdir(), 'entra-pr-gate-'));
  try {
    chmodSync(directory, 0o755);
    const files = git([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ])
      .stdout.split('\0')
      .filter(Boolean);
    for (const file of new Set(files)) {
      const source = resolve(root, file);
      const path = relative(root, source);
      if (!path || isAbsolute(path) || path.split(sep).includes('..'))
        throw new Error(`Unsafe gate input path: ${file}`);
      const parts = path.split(sep);
      const lower = parts.map((part) => part.toLowerCase());
      if (
        lower.some((part) => part === '.git' || part === 'node_modules') ||
        lower.some((part) => part === '.env' || part.startsWith('.env.')) ||
        (lower[0] === '.agents' && lower[1] === 'harness.local.json') ||
        (lower[0] === '.agents' && lower[1] === 'tmp')
      )
        continue;
      let missing = false;
      for (let index = 1; index <= parts.length; index++) {
        let stat;
        try {
          stat = lstatSync(join(root, ...parts.slice(0, index)));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          missing = true;
          break;
        }
        if (stat.isSymbolicLink())
          throw new Error(`Symlinks are not supported in gate input: ${file}`);
        if (index === parts.length && !stat.isFile())
          throw new Error(`Gate input must be a regular file: ${file}`);
      }
      if (missing) continue; // Tracked deletions are absent from this snapshot.
      const destination = join(directory, path);
      mkdirSync(dirname(destination), { recursive: true });
      for (let index = 1; index < parts.length; index++)
        chmodSync(join(directory, ...parts.slice(0, index)), 0o755);
      copyFileSync(source, destination);
      chmodSync(destination, 0o644);
    }
    return run(
      'docker',
      [
        'run',
        '--rm',
        '--pull=never',
        '--network=none',
        '--read-only',
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        '--user=65534:65534',
        '--pids-limit=256',
        '--memory=2g',
        '--cpus=2',
        '--tmpfs=/workspace:rw,nosuid,nodev,size=1g,mode=1777',
        '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m,mode=1777',
        '--mount',
        `type=bind,source=${directory},target=/input,readonly`,
        '--workdir=/workspace',
        '--env=HOME=/tmp',
        '--entrypoint=/bin/sh',
        image,
        '-c',
        GATE,
      ],
      { allowFail: true },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
