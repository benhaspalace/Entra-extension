import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadLocalConfig } from '../scripts/harness/config.mjs';
import {
  assertClean,
  checkFiles,
  checkGit,
  checkGithub,
  findForbidden,
  ForbiddenTermError,
  NEUTRAL_STOP,
  stopComment,
} from '../scripts/harness/terms.mjs';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadLocalConfig: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet-marker'] });
});

describe('forbidden text policy', () => {
  it('matches literal case-insensitive substrings once in configured order', () => {
    expect(
      findForbidden('prefixVIOLET-markerSuffix and a.b a.b', [
        'a.b',
        'violet-marker',
        'A.B',
        'absent',
      ]),
    ).toEqual(['a.b', 'violet-marker']);
    expect(findForbidden('axb', ['a.b'])).toEqual([]);
    expect(findForbidden('anything', [])).toEqual([]);
  });

  it('names the label and term locally but uses a neutral public failure', () => {
    expect(() => assertClean('PR body', 'A VIOLET-MARKER result')).toThrow(
      /PR body.*violet-marker/,
    );
    expect(
      stopComment(new ForbiddenTermError('PR body', ['violet-marker'])),
    ).toBe(NEUTRAL_STOP);
    expect(stopComment(new Error('failed with VIOLET-MARKER'))).toBe(
      NEUTRAL_STOP,
    );
    expect(NEUTRAL_STOP).not.toMatch(/violet-marker/i);
    expect(stopComment(new Error('network failed'))).toContain(
      'network failed',
    );
    loadLocalConfig.mockReturnValue({});
    expect(() => assertClean('PR body', 'violet-marker')).not.toThrow();
  });

  it.each([
    ['PR body', ['pr', 'create', '--body', 'VIOLET-MARKER']],
    ['PR title', ['pr', 'create', '--title', 'violet-marker']],
    ['issue title', ['issue', 'create', '--title', 'violet-marker']],
    ['issue comment', ['issue', 'comment', '17', '--body', 'violet-marker']],
  ])('blocks outbound %s arguments', (_label, args) => {
    expect(() => checkGithub(args)).toThrow(ForbiddenTermError);
  });

  it('checks body files, stdin, and decoded JSON escapes', () => {
    readFileSync.mockReturnValue('Violet-marker');
    expect(() =>
      checkGithub(['issue', 'create', '--body-file', 'body.md']),
    ).toThrow(/GitHub text file/);
    expect(() =>
      checkGithub(['api', 'endpoint', '--input', '-'], {
        input: '{"body":"violet-marker"}',
      }),
    ).toThrow(/GitHub text file/);
    expect(() =>
      checkGithub(['api', 'endpoint'], {
        input: '{"body":"violet\\u002dmarker"}',
      }),
    ).toThrow(/GitHub JSON input/);
    expect(() =>
      checkGithub(['api', 'endpoint'], { input: 'clean' }),
    ).not.toThrow();
  });

  it('checks decoded string values including quotes and JSON input files', () => {
    loadLocalConfig.mockReturnValue({ forbiddenTerms: ['violet"marker'] });
    const input = JSON.stringify({ nested: [{ body: 'VIOLET"MARKER' }] });
    expect(() => checkGithub(['api', 'endpoint'], { input })).toThrow(
      /GitHub JSON input/,
    );
    readFileSync.mockReturnValue(input);
    expect(() =>
      checkGithub(['api', 'endpoint', '--input', 'payload.json']),
    ).toThrow(/GitHub JSON input/);
  });

  it('does no file or git reads without a local list', () => {
    loadLocalConfig.mockReturnValue({});
    const git = vi.fn();
    checkFiles(git);
    checkGit(['commit', '-m', 'violet-marker'], git);
    checkGithub(['pr', 'create', '--body-file', 'absent.md']);
    expect(git).not.toHaveBeenCalled();
    expect(readFileSync).not.toHaveBeenCalled();
  });
});

describe('staged and tracked file checks', () => {
  const index = '100644 abc 0\tfile with spaces.txt\0';
  const git = vi.fn();

  beforeEach(() => {
    git.mockReset();
    git.mockImplementation(([command]) => ({
      stdout: command === 'ls-files' ? index : 'clean staged text',
    }));
    readFileSync.mockReturnValue('clean working text');
  });

  it('checks both versions, using NUL-delimited paths without shell quoting', () => {
    checkFiles(git);
    expect(git).toHaveBeenCalledWith(['ls-files', '--stage', '-z']);
    expect(git).toHaveBeenCalledWith(['show', ':0:file with spaces.txt']);
    expect(readFileSync).toHaveBeenCalledWith('file with spaces.txt', 'utf8');
    readFileSync.mockReturnValue('violet-marker');
    expect(() => checkFiles(git)).toThrow(/Tracked file.*violet-marker/);
  });

  it('blocks forbidden staged text even if the working copy is clean or deleted', () => {
    git.mockImplementation(([command]) => ({
      stdout: command === 'ls-files' ? index : 'VIOLET-MARKER',
    }));
    expect(() => checkFiles(git)).toThrow(/Staged file.*violet-marker/);
  });

  it('allows unstaged deletions but surfaces other read failures', () => {
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    expect(() => checkFiles(git)).not.toThrow();
    readFileSync.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' });
    });
    expect(() => checkFiles(git)).toThrow(/denied/);
  });

  it('skips submodules and checks conflict stages', () => {
    git.mockReturnValueOnce({
      stdout: '160000 abc 0\tsubmodule\0' + '100644 def 2\tconflict.txt\0',
    });
    checkFiles(git);
    expect(git).toHaveBeenCalledWith(['show', ':2:conflict.txt']);
    expect(git).not.toHaveBeenCalledWith(['show', ':0:submodule']);
  });

  it('guards commit messages, message files and contents before commit or push', () => {
    expect(() => checkGit(['commit', '-m', 'VIOLET-MARKER'], git)).toThrow(
      /Git argument/,
    );
    readFileSync.mockReturnValue('violet-marker');
    expect(() => checkGit(['commit', '-F', 'message.txt'], git)).toThrow(
      /Commit message/,
    );
    for (const command of ['commit', 'push'])
      expect(() => checkGit([command], git)).toThrow(/Tracked file/);
    git.mockClear();
    checkGit(['status'], git);
    expect(git).not.toHaveBeenCalled();
  });
});
