import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import {
  checkVersion,
  checkPermissionDecisions,
  checkManifest,
} from '../scripts/check-manifest.mjs';
import { ci } from '../scripts/ci.mjs';
import { packageExtension } from '../scripts/package.mjs';
import { git } from '../scripts/harness/process.mjs';

vi.mock('../scripts/harness/process.mjs', () => ({ git: vi.fn() }));
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const decisions = readFileSync('docs/permissions-decisions.md', 'utf8');

beforeEach(() => {
  vi.resetAllMocks();
  git.mockImplementation((args) => ({
    stdout: args.includes('--is-shallow-repository')
      ? 'false'
      : args[0] === 'rev-parse'
        ? 'a'.repeat(40)
        : '',
  }));
});

describe('manifest gates', () => {
  it('requires identical valid manifest/package versions', () => {
    expect(() =>
      checkVersion({ version: '1.2.3' }, { version: '1.2.3' }),
    ).not.toThrow();
    for (const version of ['1.2.4', undefined, 'bad', '1.2.3-beta'])
      expect(() => checkVersion({ version }, { version: '1.2.3' })).toThrow(
        /versions must match/,
      );
  });
  it('documents all initial grants and allows removals but not additions by default', () => {
    expect(checkPermissionDecisions(manifest, {}, decisions)).toHaveLength(8);
    expect(
      checkPermissionDecisions(
        {},
        manifest,
        '- `content_security_policy.extension_pages:<removed>` - Intentional removal.',
      ),
    ).toEqual(['content_security_policy.extension_pages:<removed>']);
    expect(checkPermissionDecisions(manifest, manifest, '')).toEqual([]);
    expect(() =>
      checkPermissionDecisions(
        { permissions: ['new'] },
        {},
        'A mention of permissions:new',
      ),
    ).toThrow(/permissions:new/);
  });
  it.each([
    [{ permissions: ['new'] }, 'permissions:new'],
    [{ host_permissions: ['https://new/*'] }, 'host_permissions:https://new/*'],
    [
      { content_scripts: [{ matches: ['https://new/*'] }] },
      'content_scripts.matches:https://new/*',
    ],
    [
      {
        content_security_policy: {
          extension_pages: "script-src 'unsafe-eval'",
        },
      },
      "content_security_policy.extension_pages:script-src 'unsafe-eval'",
    ],
  ])('requires an exact decision and a rationale for %j', (current, grant) => {
    expect(() => checkPermissionDecisions(current, {}, '')).toThrow(
      /Undocumented/,
    );
    expect(() =>
      checkPermissionDecisions(current, {}, `- \`${grant}\` - `),
    ).toThrow();
    expect(
      checkPermissionDecisions(
        current,
        {},
        `- \`${grant}\` - Accepted for this reason.`,
      ),
    ).toEqual([grant]);
  });
  it('excludes release tags on HEAD and reads the preceding tagged manifest', () => {
    git.mockImplementation((args) => {
      const command = args.join(' ');
      if (command.includes('--is-shallow')) return { stdout: 'false' };
      if (args[0] === 'tag') return { stdout: 'v0.1.0\nv0.0.9\n' };
      if (args[0] === 'show') return { stdout: JSON.stringify(manifest) };
      return {
        stdout: command.includes('v0.0.9') ? 'b'.repeat(40) : 'a'.repeat(40),
      };
    });
    checkManifest();
    expect(git).toHaveBeenCalledWith(['show', 'v0.0.9:manifest.json']);
    git.mockReturnValue({ stdout: 'true' });
    expect(() => checkManifest()).toThrow(/full Git history/);
  });
});

describe('local CI parity', () => {
  it('runs verify and actionlint with deterministic optional integrations disabled', () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    ci(spawn, {
      npm_execpath: 'npm-cli',
      ACTIONLINT: 'pinned-linter',
      CI: 'true',
    });
    expect(spawn.mock.calls.map(([command, args]) => [command, args])).toEqual([
      [process.execPath, ['npm-cli', 'run', 'verify']],
      ['pinned-linter', ['-color', '-shellcheck=', '-pyflakes=']],
    ]);
  });
  it('skips only a missing local linter; CI, linter errors, and verify failures fail', () => {
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValue({ error: { code: 'ENOENT', message: 'missing' } });
    expect(() => ci(spawn, {})).not.toThrow();
    spawn.mockReturnValueOnce({ status: 0 });
    expect(() => ci(spawn, { CI: 'true' })).toThrow(/actionlint/);
    spawn.mockReturnValue({ status: 1 });
    expect(() => ci(spawn, {})).toThrow(/Verification/);
    expect(spawn.mock.calls.at(-1)[0]).toBe(process.execPath);
  });
});

describe('release packaging', () => {
  it('reuses the build artifact and replaces verified assets on publish retries', () => {
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    const [build, publish] = workflow.split('\n  publish:');
    const artifact = 'extension-${{ github.run_id }}-${{ github.run_attempt }}';
    expect(build).toContain(`artifact: ${artifact}`);
    expect(build).toContain(`name: ${artifact}`);
    expect(publish).toContain('name: ${{ needs.build.outputs.artifact }}');
    expect(publish).not.toContain('github.run_attempt');
    const verify = publish.indexOf('sha256sum --check --strict SHA256SUMS');
    const upload = publish.indexOf(
      'gh release upload "v$VERSION" "release/extension-$VERSION.zip" release/SHA256SUMS --clobber',
    );
    expect(verify).toBeGreaterThanOrEqual(0);
    expect(upload).toBeGreaterThan(verify);
  });
  it('zips the dist contents at the root and writes a matching SHA256SUMS', () => {
    const directory = mkdtempSync(join(tmpdir(), 'extension-package-'));
    try {
      const dist = join(directory, 'dist');
      const output = join(directory, 'release');
      mkdirSync(join(dist, 'sidepanel'), { recursive: true });
      writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest));
      writeFileSync(join(dist, 'sidepanel', 'index.html'), '<p>Panel</p>');
      const { name, archive } = packageExtension(dist, output);
      expect(name).toBe(`extension-${manifest.version}.zip`);
      const files = unzipSync(archive);
      expect(Object.keys(files).sort()).toEqual([
        'manifest.json',
        'sidepanel/index.html',
      ]);
      expect(strFromU8(files['sidepanel/index.html'])).toBe('<p>Panel</p>');
      expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toBe(
        `${createHash('sha256').update(archive).digest('hex')}  ${name}\n`,
      );
      writeFileSync(
        join(dist, 'manifest.json'),
        JSON.stringify({ ...manifest, version: '99.0.0' }),
      );
      expect(() => packageExtension(dist, output)).toThrow(
        /versions must match/,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
