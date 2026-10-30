import { beforeEach, describe, expect, it, vi } from 'vitest';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { resolveAgentExecutable } from '../scripts/harness/executable.mjs';

vi.mock('node:fs', () => ({
  accessSync: vi.fn(),
  constants: { F_OK: 0, X_OK: 1 },
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

const root = process.cwd();
const trusted = resolve(tmpdir(), 'trusted-agent-tools');
const name = process.platform === 'win32' ? 'agent-cli.cmd' : 'agent-cli';
const executable = join(trusted, name);
const missing = () => {
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
};

beforeEach(() => {
  vi.resetAllMocks();
  realpathSync.mockImplementation((path) => {
    if (path === root || path === executable) return path;
    return missing();
  });
  statSync.mockReturnValue({ isFile: () => true });
});

describe('trusted agent executable resolution', () => {
  it('skips npm repository bins, empty/relative PATH entries and resolves an absolute external executable', () => {
    const localBin = join(root, 'node_modules', '.bin');
    const PATH = [localBin, '', '.', 'relative-tools', trusted].join(delimiter);
    expect(resolveAgentExecutable('agent-cli', { PATH })).toBe(executable);
    expect(realpathSync.mock.calls.flat()).not.toContain(join(localBin, name));
    expect(accessSync).toHaveBeenCalledWith(
      executable,
      process.platform === 'win32' ? constants.F_OK : constants.X_OK,
    );
  });

  it('rejects an external PATH symlink resolving back into the repository', () => {
    realpathSync.mockImplementation((path) => {
      if (path === root) return root;
      if (path === executable) return join(root, 'node_modules', '.bin', name);
      return missing();
    });
    expect(() =>
      resolveAgentExecutable('agent-cli', { PATH: trusted }),
    ).toThrow(/Cannot find trusted agent executable/);
    expect(accessSync).not.toHaveBeenCalled();
  });

  it('fails closed without an installed executable outside the repository', () => {
    expect(() =>
      resolveAgentExecutable('agent-cli', {
        PATH: join(root, 'node_modules', '.bin'),
      }),
    ).toThrow(/Cannot find trusted agent executable/);
  });

  it('skips non-executable files and surfaces unexpected filesystem failures', () => {
    accessSync.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() =>
      resolveAgentExecutable('agent-cli', { PATH: trusted }),
    ).toThrow(/Cannot find trusted agent executable/);
    accessSync.mockImplementation(() => {
      throw Object.assign(new Error('I/O failure'), { code: 'EIO' });
    });
    expect(() =>
      resolveAgentExecutable('agent-cli', { PATH: trusted }),
    ).toThrow(/I\/O failure/);
  });
});
