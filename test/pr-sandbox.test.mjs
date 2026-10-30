import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { git, run } from '../scripts/harness/process.mjs';
import { verifyInSandbox } from '../scripts/pr/sandbox.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';

vi.mock('../scripts/harness/config.mjs', () => ({ loadLocalConfig: vi.fn() }));
vi.mock('../scripts/harness/process.mjs', () => ({
  git: vi.fn(),
  run: vi.fn(),
}));

const image = `sha256:${'a'.repeat(64)}`;
let root;
let snapshot;
let files;

function file(path, content = 'source') {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
  files.push(path);
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PR_GATE_IMAGE', image);
  loadLocalConfig.mockReturnValue({});
  root = mkdtempSync(join(tmpdir(), 'entra-pr-sandbox-test-'));
  files = [];
  snapshot = undefined;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  git.mockImplementation(() => ({ stdout: files.join('\0') }));
  run.mockImplementation((command, args) => {
    const mount = args[args.indexOf('--mount') + 1];
    snapshot = /^type=bind,source=(.*),target=\/input,readonly$/.exec(mount)[1];
    return { ok: true, stdout: 'verified', output: 'verified' };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('isolated PR quality gate', () => {
  it('falls back to local prGateImage when the environment override is absent', () => {
    vi.stubEnv('PR_GATE_IMAGE', undefined);
    loadLocalConfig.mockReturnValue({ prGateImage: image });
    verifyInSandbox();
    expect(run.mock.calls[0][1]).toContain(image);
  });

  it('prefers the environment image and rejects an invalid override instead of falling back', () => {
    loadLocalConfig.mockReturnValue({
      prGateImage: `sha256:${'b'.repeat(64)}`,
    });
    verifyInSandbox();
    expect(run.mock.calls[0][1]).toContain(image);
    expect(loadLocalConfig).not.toHaveBeenCalled();
    vi.stubEnv('PR_GATE_IMAGE', 'mutable:tag');
    expect(() => verifyInSandbox()).toThrow(/host execution is disabled/);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid local image and surfaces unreadable configuration', () => {
    vi.stubEnv('PR_GATE_IMAGE', undefined);
    loadLocalConfig.mockReturnValue({ prGateImage: 'mutable:tag' });
    expect(() => verifyInSandbox()).toThrow(/host execution is disabled/);
    loadLocalConfig.mockImplementationOnce(() => {
      throw new Error('Cannot read local configuration');
    });
    expect(() => verifyInSandbox()).toThrow(/Cannot read local configuration/);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs a fixed gate in a disposable, unprivileged, offline container with only a read-only source snapshot', () => {
    file('package.json', '{"scripts":{"verify":"malicious host command"}}');
    file(join('src', 'new.ts'), 'new change');
    files.push('deleted.ts');
    const invoke = run.getMockImplementation();
    run.mockImplementation((command, args, options) => {
      const result = invoke(command, args, options);
      expect(readFileSync(join(snapshot, 'package.json'), 'utf8')).toContain(
        'malicious host command',
      );
      expect(readFileSync(join(snapshot, 'src', 'new.ts'), 'utf8')).toBe(
        'new change',
      );
      expect(existsSync(join(snapshot, 'deleted.ts'))).toBe(false);
      return result;
    });
    expect(verifyInSandbox()).toEqual({
      ok: true,
      stdout: 'verified',
      output: 'verified',
    });
    expect(git).toHaveBeenCalledWith([
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    const [command, args, options] = run.mock.calls[0];
    expect(command).toBe('docker');
    expect(options).toEqual({ allowFail: true });
    expect(args).toEqual([
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
      `type=bind,source=${snapshot},target=/input,readonly`,
      '--workdir=/workspace',
      '--env=HOME=/tmp',
      '--entrypoint=/bin/sh',
      image,
      '-c',
      expect.any(String),
    ]);
    expect(args.at(-1)).not.toContain('npm run');
    for (const step of [
      'node scripts/build.mjs',
      'node node_modules/vitest/vitest.mjs run',
      'node node_modules/eslint/bin/eslint.js .',
      'node node_modules/typescript/bin/tsc --noEmit',
    ])
      expect(args.at(-1)).toContain(step);
    expect(existsSync(snapshot)).toBe(false);
  });

  it('creates a writable dependency root with image package links before every gate step', () => {
    verifyInSandbox();
    const args = run.mock.calls[0][1];
    expect(args.at(-1)).toBe(
      [
        'cp -R /input/. /workspace/',
        'cd /workspace',
        'mkdir node_modules',
        'for dependency in /opt/node_modules/*; do ln -s "$dependency" node_modules/ || exit; done',
        'node scripts/build.mjs',
        'node node_modules/vitest/vitest.mjs run',
        'node node_modules/eslint/bin/eslint.js .',
        'node node_modules/typescript/bin/tsc --noEmit',
      ].join(' && '),
    );
    expect(args).toContain(
      '--tmpfs=/workspace:rw,nosuid,nodev,size=1g,mode=1777',
    );
    expect(args).toContain('--read-only');
    expect(args.at(-1)).not.toContain('ln -s /opt/node_modules node_modules');
  });

  it('never copies ignored credentials, Git metadata, dependencies or agent artifacts, even if explicitly listed', () => {
    for (const path of [
      join('.git', 'config'),
      join('.agents', 'harness.local.json'),
      join('.agents', 'tmp', 'secret.txt'),
      join('node_modules', 'secret.txt'),
      '.env',
      '.env.local',
    ])
      file(path, 'secret');
    file('tracked.ts');
    const invoke = run.getMockImplementation();
    run.mockImplementation((command, args, options) => {
      const result = invoke(command, args, options);
      for (const path of files.filter((path) => path !== 'tracked.ts'))
        expect(existsSync(join(snapshot, path))).toBe(false);
      expect(readFileSync(join(snapshot, 'tracked.ts'), 'utf8')).toBe('source');
      return result;
    });
    verifyInSandbox();
  });

  it.each(['', 'node:latest', 'node@sha256:bad', '-malicious'])(
    'fails closed without a trusted immutable image (%s)',
    (value) => {
      vi.stubEnv('PR_GATE_IMAGE', value);
      expect(() => verifyInSandbox()).toThrow(/host execution is disabled/);
      expect(run).not.toHaveBeenCalled();
      expect(git).not.toHaveBeenCalled();
    },
  );

  it('accepts a repository digest without pulling it or passing host environment variables', () => {
    vi.stubEnv('PR_GATE_IMAGE', `trusted/gate@${image}`);
    verifyInSandbox();
    expect(run.mock.calls[0][1]).toContain(`trusted/gate@${image}`);
    expect(
      run.mock.calls[0][1].filter((arg) => arg.startsWith('--env')),
    ).toEqual(['--env=HOME=/tmp']);
  });

  it('rejects paths escaping the checkout before invoking the container', () => {
    files.push(relative(root, join(tmpdir(), 'outside.txt')));
    expect(() => verifyInSandbox()).toThrow(/Unsafe gate input path/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects symlinked directories rather than following them into host files', () => {
    file(join('private', 'secret.txt'), 'must not be copied');
    files = [join('linked', 'secret.txt')];
    symlinkSync(join(root, 'private'), join(root, 'linked'), 'junction');
    expect(() => verifyInSandbox()).toThrow(/Symlinks are not supported/);
    expect(run).not.toHaveBeenCalled();
  });

  it('surfaces Docker failures and cleans the source snapshot without falling back to host commands', () => {
    const invoke = run.getMockImplementation();
    run.mockImplementation((command, args, options) => {
      invoke(command, args, options);
      throw new Error('Docker unavailable');
    });
    expect(() => verifyInSandbox()).toThrow(/Docker unavailable/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(snapshot)).toBe(false);
  });
});
