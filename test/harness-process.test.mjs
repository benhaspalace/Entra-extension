import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { gh, git, run } from '../scripts/harness/process.mjs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadLocalConfig: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  loadLocalConfig.mockReturnValue({});
});

describe('harness process execution', () => {
  it.each(['commit', 'push'])(
    'blocks %s before invoking it when staged contents violate policy',
    (command) => {
      loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
      spawnSync.mockImplementation((_bin, args) => ({
        status: 0,
        stdout:
          args[0] === 'ls-files' ? '100644 abc 0\tfile.txt\0' : 'VIOLET-MARKER',
        stderr: '',
      }));
      expect(() => git([command])).toThrow(
        /Staged file file.txt.*violet-marker/,
      );
      expect(spawnSync.mock.calls.map(([, args]) => args[0])).toEqual([
        'ls-files',
        'show',
      ]);
    },
  );

  it('never invokes git or GitHub when outbound text violates policy', () => {
    loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
    expect(() =>
      gh(['issue', 'comment', '17', '--body', 'VIOLET-MARKER']),
    ).toThrow(/forbidden term/);
    expect(() => git(['commit', '-m', 'violet-marker'])).toThrow(
      /forbidden term/,
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('preserves stdout separately and passes input without a shell by default', () => {
    spawnSync.mockReturnValue({ status: 0, stdout: 'json', stderr: 'warning' });
    expect(gh(['api', 'graphql'], { input: '{"query":"..."}' })).toEqual({
      ok: true,
      stdout: 'json',
      output: 'jsonwarning',
    });
    expect(spawnSync).toHaveBeenCalledWith(
      'gh',
      ['api', 'graphql'],
      expect.objectContaining({
        shell: false,
        input: '{"query":"..."}',
      }),
    );
    git(['status']);
    expect(spawnSync.mock.calls[1][0]).toBe('git');
  });

  it('reports spawn errors and nonzero exits instead of returning success-shaped output', () => {
    spawnSync.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(() => run('missing', [])).toThrow(/ENOENT/);
    expect(run('missing', [], { allowFail: true })).toMatchObject({
      ok: false,
      stdout: '',
      output: expect.stringContaining('ENOENT'),
    });
    spawnSync.mockReturnValue({ status: 1, stdout: '', stderr: 'denied' });
    expect(() => run('gh', ['api'])).toThrow(/denied/);
  });
});
