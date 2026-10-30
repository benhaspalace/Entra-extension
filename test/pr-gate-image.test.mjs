import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildGateImage,
  parseImageArgs,
} from '../scripts/pr/build-gate-image.mjs';
import { git, run } from '../scripts/harness/process.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';

vi.mock('../scripts/harness/process.mjs', () => ({
  git: vi.fn(),
  run: vi.fn(),
}));
vi.mock('../scripts/harness/config.mjs', () => ({ loadLocalConfig: vi.fn() }));
const revision = 'a'.repeat(40);
const baseImage = `node@sha256:${'b'.repeat(64)}`;
const image = `sha256:${'c'.repeat(64)}`;
const manifest = '{"name":"trusted","devDependencies":{"tool":"1.0.0"}}';
const lock = '{"name":"trusted","lockfileVersion":3}';
const ok = (stdout = '') => ({ ok: true, stdout, output: stdout });
let root;
let context;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'entra-image-test-'));
  context = undefined;
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  loadLocalConfig.mockReturnValue({
    cli: 'preserved-cli',
    models: { implement: 'preserved-model' },
  });
  git.mockImplementation((args) => {
    if (args[0] === 'rev-parse') return ok(revision);
    if (args[1] === `${revision}:package-lock.json`) return ok(lock);
    if (args[1] === `${revision}:package.json`) return ok(manifest);
    throw new Error(`Unexpected git command: ${args}`);
  });
  run.mockImplementation((command, args) => {
    expect(command).toBe('docker');
    if (args[0] === 'pull') return ok();
    if (args[0] === 'inspect') return ok(JSON.stringify([baseImage]));
    if (args[0] === 'build') {
      context = args.at(-1);
      writeFileSync(args[args.indexOf('--iidfile') + 1], image);
      return ok();
    }
    throw new Error(`Unexpected Docker command: ${args}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('gate image provisioning', () => {
  it('defaults to origin/main and accepts an explicit trusted ref', () => {
    expect(parseImageArgs([])).toEqual({ ref: 'origin/main' });
    expect(parseImageArgs(['--ref', 'trusted/release'])).toEqual({
      ref: 'trusted/release',
    });
  });

  it.each([
    ['--ref'],
    ['--ref', ''],
    ['--ref', ' '],
    ['--ref', '--bad'],
    ['--ref', 'main\nbad'],
    ['--ref', 'bad\0ref'],
    ['main'],
    ['--unknown'],
    ['--ref', 'main', 'extra'],
  ])('rejects invalid CLI input %j before git or Docker', (...argv) => {
    expect(() => buildGateImage(argv)).toThrow(/Usage/);
    expect(git).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('uses only manifests from the resolved revision, pins the base, records provenance and preserves local settings', () => {
    const invoke = run.getMockImplementation();
    run.mockImplementation((command, args) => {
      const result = invoke(command, args);
      if (args[0] === 'build') {
        expect(readFileSync(join(context, 'package.json'), 'utf8')).toBe(
          manifest,
        );
        expect(readFileSync(join(context, 'package-lock.json'), 'utf8')).toBe(
          lock,
        );
        const dockerfile = readFileSync(join(context, 'Dockerfile'), 'utf8');
        expect(dockerfile).toContain('FROM ${NODE_IMAGE}');
        expect(dockerfile).toContain('WORKDIR /opt');
        expect(dockerfile).toContain('npm ci --ignore-scripts');
        expect(dockerfile).toContain('chmod -R a+rX /opt/node_modules');
        expect(args).toContain(`NODE_IMAGE=${baseImage}`);
        expect(args).toContain(`TRUSTED_REVISION=${revision}`);
        expect(args).toContain('--pull=false');
      }
      return result;
    });
    expect(buildGateImage([])).toBe(image);
    expect(git.mock.calls.map(([args]) => args)).toEqual([
      ['rev-parse', '--verify', '--end-of-options', 'origin/main^{commit}'],
      ['show', `${revision}:package-lock.json`],
      ['show', `${revision}:package.json`],
    ]);
    expect(
      run.mock.calls.slice(0, 2).map(([command, args]) => [command, args]),
    ).toEqual([
      ['docker', ['pull', 'node:22-bookworm-slim']],
      [
        'docker',
        [
          'inspect',
          '--format',
          '{{json .RepoDigests}}',
          'node:22-bookworm-slim',
        ],
      ],
    ]);
    expect(
      JSON.parse(
        readFileSync(join(root, '.agents', 'harness.local.json'), 'utf8'),
      ),
    ).toEqual({
      cli: 'preserved-cli',
      models: { implement: 'preserved-model' },
      prGateImage: image,
      prGateImageSource: { revision, baseImage },
    });
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining(image));
    expect(existsSync(context)).toBe(false);
  });

  it('resolves --ref once, never a working-tree manifest', () => {
    buildGateImage(['--ref', 'trusted/release']);
    expect(git.mock.calls[0][0]).toEqual([
      'rev-parse',
      '--verify',
      '--end-of-options',
      'trusted/release^{commit}',
    ]);
    expect(
      git.mock.calls
        .slice(1)
        .every(([args]) => args[1].startsWith(`${revision}:`)),
    ).toBe(true);
  });

  it('suggests --ref when the trusted revision has no lockfile, without invoking Docker', () => {
    git
      .mockReturnValueOnce(ok(revision))
      .mockReturnValueOnce({
        ok: false,
        stdout: '',
        output: 'path does not exist',
      });
    expect(() => buildGateImage([])).toThrow(
      /origin\/main.*package-lock\.json.*--ref/s,
    );
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.agents', 'harness.local.json'))).toBe(false);
  });

  it('surfaces invalid refs and missing manifests without invoking Docker', () => {
    git.mockImplementationOnce(() => {
      throw new Error('unknown revision');
    });
    expect(() => buildGateImage(['--ref', 'missing'])).toThrow(
      /unknown revision/,
    );
    git.mockReturnValueOnce(ok('invalid'));
    expect(() => buildGateImage([])).toThrow(/Cannot resolve trusted revision/);
    git
      .mockReturnValueOnce(ok(revision))
      .mockReturnValueOnce(ok(lock))
      .mockImplementationOnce(() => {
        throw new Error('missing manifest');
      });
    expect(() => buildGateImage([])).toThrow(/missing manifest/);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(['broken JSON', 'null', '[]'])(
    'rejects invalid trusted manifests (%s)',
    (text) => {
      git.mockReturnValueOnce(ok(revision)).mockReturnValueOnce(ok(text));
      expect(() => buildGateImage([])).toThrow();
      expect(run).not.toHaveBeenCalled();
    },
  );

  it.each(['[]', 'null', '["node:22"]', `["other@sha256:${'b'.repeat(64)}"]`])(
    'fails closed without a Node base digest (%s)',
    (digests) => {
      run.mockReturnValueOnce(ok()).mockReturnValueOnce(ok(digests));
      expect(() => buildGateImage([])).toThrow(/digest-pinned Node 22/);
      expect(run).toHaveBeenCalledTimes(2);
      expect(existsSync(join(root, '.agents', 'harness.local.json'))).toBe(
        false,
      );
    },
  );

  it('surfaces unavailable Docker without updating local config', () => {
    run.mockImplementationOnce(() => {
      throw new Error('Docker unavailable');
    });
    expect(() => buildGateImage([])).toThrow(/Docker unavailable/);
    expect(existsSync(join(root, '.agents', 'harness.local.json'))).toBe(false);
  });

  it.each(['failed build', 'invalid image ID'])(
    'cleans temporary inputs and preserves config on %s',
    (failure) => {
      const invoke = run.getMockImplementation();
      run.mockImplementation((command, args) => {
        if (args[0] !== 'build') return invoke(command, args);
        context = args.at(-1);
        if (failure === 'failed build') throw new Error('failed build');
        writeFileSync(args[args.indexOf('--iidfile') + 1], 'node:mutable');
        return ok();
      });
      expect(() => buildGateImage([])).toThrow(
        failure === 'failed build' ? /failed build/ : /valid gate image ID/,
      );
      expect(existsSync(context)).toBe(false);
      expect(existsSync(join(root, '.agents', 'harness.local.json'))).toBe(
        false,
      );
    },
  );

  it('does not provision when local configuration cannot be read', () => {
    loadLocalConfig.mockImplementationOnce(() => {
      throw new Error('Cannot read local configuration');
    });
    expect(() => buildGateImage([])).toThrow(/Cannot read local configuration/);
    expect(git).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
