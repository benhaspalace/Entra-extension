import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { runAgent } from '../scripts/harness/agent.mjs';
import { loadConfig } from '../scripts/harness/config.mjs';
import { gh, git, run } from '../scripts/harness/process.mjs';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/agent.mjs', () => ({ runAgent: vi.fn() }));
vi.mock('../scripts/harness/config.mjs', () => ({
  loadConfig: vi.fn(),
  resolveModel: vi.fn(() => 'model-a'),
}));
vi.mock('../scripts/harness/process.mjs', () => ({
  gh: vi.fn(),
  git: vi.fn(),
  run: vi.fn(),
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
let review;

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  process.argv = [...originalArgv.slice(0, 2), '12'];
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  loadConfig.mockReturnValue({
    maxAttempts: 1,
    gate: ['npm run verify'],
    labels: {
      ready: 'agent:ready',
      status: {
        inProgress: 'agent:in-progress',
        inReview: 'agent:in-review',
        needsHuman: 'agent:needs-human',
      },
    },
  });
  git.mockImplementation((args) => ({
    stdout: args[0] === 'rev-parse' ? 'main' : '',
  }));
  gh.mockImplementation((args) => ({
    ok: true,
    stdout:
      args[0] === 'issue' && args[1] === 'view'
        ? JSON.stringify({
            number: 12,
            title: 'Fix defect',
            body: '',
            labels: [],
          })
        : 'https://example.invalid/pr/12',
  }));
  run.mockReturnValue({ ok: true, output: '' });
  review = {
    findings: [
      { severity: 'high', summary: 'Fix this defect' },
      { severity: 'low', summary: 'Keep this note' },
    ],
  };
  runAgent.mockImplementation(({ task }) => ({
    ok: true,
    stdout: JSON.stringify(task === 'review' ? review : {}),
  }));
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('issue harness with mocked external operations', () => {
  it('keeps gate and review details in PR bodies without tool attribution', async () => {
    await import('../scripts/harness/run.mjs');
    const body = writeFileSync.mock.calls.find(([path]) =>
      path.endsWith('pr.md'),
    )?.[1];
    expect(body).toContain('Closes #12');
    expect(body).toContain(
      'Gate (`npm run verify`) passed after 2 attempt(s).',
    );
    expect(body).toContain(
      '### Review findings fixed\n- **high**: Fix this defect',
    );
    expect(body).toContain(
      '### Low-severity notes (not fixed)\n- **low**: Keep this note',
    );
    expect(body).not.toMatch(/agent|model|workflow/i);
  });

  it('retries malformed findings and stops before publishing if still invalid', async () => {
    review = {
      findings: [{ severity: 'high', description: 'Missing summary' }],
    };
    await import('../scripts/harness/run.mjs');
    expect(
      runAgent.mock.calls.filter(([{ task }]) => task === 'review'),
    ).toHaveLength(2);
    expect(process.exitCode).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('the change is unreviewed'),
    );
    expect(gh.mock.calls.some(([args]) => args[0] === 'pr')).toBe(false);
    expect(git.mock.calls.some(([args]) => args[0] === 'commit')).toBe(false);
  });
});
