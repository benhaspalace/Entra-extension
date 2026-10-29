import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { gh, git, run } from '../scripts/harness/process.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

describe('harness process execution', () => {
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
