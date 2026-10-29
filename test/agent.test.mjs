import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/harness/process.mjs';
import { runAgent } from '../scripts/harness/agent.mjs';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/process.mjs', () => ({ run: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  for (const key of [
    'AGENT_CLI',
    'REVIEW_BOT_LOGIN',
    'AGENT_MODEL_IMPLEMENT',
    'AGENT_MODEL_REVIEW',
  ])
    vi.stubEnv(key, undefined);
  readFileSync.mockImplementation((path) =>
    JSON.stringify(
      path.endsWith('harness.config.json')
        ? { tasks: ['implement', 'review'] }
        : {
            cli: 'agent-cli',
            models: { implement: 'model-a', review: 'model-b' },
            reviewBotLogin: 'review-bot[bot]',
          },
    ),
  );
  run.mockReturnValue({ ok: true, stdout: 'reply', output: 'reply\nstderr' });
});

describe('shared agent runner', () => {
  it('writes prompt and combined reply, invokes the configured model, and returns all output', () => {
    expect(
      runAgent({ role: 'test-1', task: 'implement', prompt: 'Do the work.' }),
    ).toEqual({
      ok: true,
      stdout: 'reply',
      output: 'reply\nstderr',
    });
    expect(mkdirSync).toHaveBeenCalledWith(join('.agents', 'tmp'), {
      recursive: true,
    });
    expect(writeFileSync).toHaveBeenCalledWith(
      join('.agents', 'tmp', 'test-1-prompt.md'),
      'Do the work.',
    );
    expect(writeFileSync).toHaveBeenCalledWith(
      join('.agents', 'tmp', 'test-1-reply.md'),
      'reply\nstderr',
    );
    const [cli, args, options] = run.mock.calls[0];
    expect(cli).toBe('agent-cli');
    expect(args.slice(0, 2)).toEqual(['--model', 'model-a']);
    const instruction = `Read ${join('.agents', 'tmp', 'test-1-prompt.md')} and follow it exactly.`;
    expect(args[3]).toBe(
      process.platform === 'win32' ? `"${instruction}"` : instruction,
    );
    expect(options).toEqual({
      allowFail: true,
      shell: process.platform === 'win32',
    });
  });

  it('preserves read-only restrictions and explicit issue-harness model overrides', () => {
    runAgent({
      role: 'review',
      task: 'review',
      prompt: 'Review.',
      readOnly: true,
      model: 'custom-model',
    });
    expect(run.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'custom-model',
        '--deny-tool',
        'write',
        '--deny-tool',
        'shell',
      ]),
    );
  });

  it('writes preview artifacts without invoking agent in a dry run', () => {
    expect(
      runAgent({
        role: 'preview',
        task: 'implement',
        prompt: 'Preview.',
        dryRun: true,
      }),
    ).toEqual({
      ok: true,
      stdout: '',
      output: '',
    });
    expect(run).not.toHaveBeenCalled();
    expect(writeFileSync).toHaveBeenCalledWith(
      join('.agents', 'tmp', 'preview-reply.md'),
      '',
    );
  });

  it.each([false, true])(
    'uses an explicit override without a configured task default (dryRun: %s)',
    (dryRun) => {
      vi.stubEnv('AGENT_MODEL_IMPLEMENT', '');
      runAgent({
        role: 'override',
        task: 'implement',
        prompt: 'Work.',
        model: 'custom-model',
        dryRun,
      });
      if (dryRun) expect(run).not.toHaveBeenCalled();
      else
        expect(run.mock.calls[0][1].slice(0, 2)).toEqual([
          '--model',
          'custom-model',
        ]);
    },
  );

  it('uses an explicit override when the task default is missing', () => {
    readFileSync.mockImplementation((path) =>
      JSON.stringify(
        path.endsWith('harness.config.json')
          ? { tasks: ['implement'] }
          : { cli: 'agent-cli', reviewBotLogin: 'review-bot[bot]' },
      ),
    );
    runAgent({
      role: 'override',
      task: 'implement',
      prompt: 'Work.',
      model: 'custom-model',
    });
    expect(run.mock.calls[0][1].slice(0, 2)).toEqual([
      '--model',
      'custom-model',
    ]);
  });

  it.each(['implement', 'review', 'retro'])(
    'allows a per-run %s override without a configured model',
    (task) => {
      readFileSync.mockImplementation((path) =>
        JSON.stringify(
          path.endsWith('harness.config.json')
            ? { tasks: ['implement', 'review', 'retro'] }
            : { cli: 'agent-cli', reviewBotLogin: 'review-bot[bot]' },
        ),
      );
      runAgent({ role: task, task, prompt: 'Work.', model: 'custom-model' });
      expect(run.mock.calls[0][1].slice(0, 2)).toEqual([
        '--model',
        'custom-model',
      ]);
    },
  );

  it('requires a configured model when no override is supplied', () => {
    vi.stubEnv('AGENT_MODEL_IMPLEMENT', '');
    expect(() =>
      runAgent({ role: 'invalid', task: 'implement', prompt: 'Work.' }),
    ).toThrow(/Invalid agent model/);
    vi.stubEnv('AGENT_MODEL_IMPLEMENT', undefined);
    readFileSync.mockImplementation((path) =>
      JSON.stringify(
        path.endsWith('harness.config.json')
          ? { tasks: ['implement'] }
          : { cli: 'agent-cli', reviewBotLogin: 'review-bot[bot]' },
      ),
    );
    expect(() =>
      runAgent({ role: 'missing', task: 'implement', prompt: 'Work.' }),
    ).toThrow(/No agent model configured/);
    expect(run).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('returns failures with their reply artifacts and rejects unsafe roles', () => {
    run.mockReturnValue({ ok: false, stdout: '', output: 'CLI unavailable' });
    expect(
      runAgent({ role: 'failure', task: 'implement', prompt: 'Work.' }).ok,
    ).toBe(false);
    expect(writeFileSync).toHaveBeenCalledWith(
      join('.agents', 'tmp', 'failure-reply.md'),
      'CLI unavailable',
    );
    expect(() =>
      runAgent({ role: '..\\escape', task: 'implement', prompt: '' }),
    ).toThrow(/safe file name/);
  });

  it('does not silently default invalid overrides or allow them to invent tasks', () => {
    expect(() =>
      runAgent({
        role: 'invalid',
        task: 'implement',
        prompt: '',
        model: '',
      }),
    ).toThrow(/Invalid agent model/);
    expect(() =>
      runAgent({
        role: 'unknown',
        task: 'unknown',
        prompt: '',
        model: 'model-a',
      }),
    ).toThrow(/Unknown agent task/);
    expect(run).not.toHaveBeenCalled();
  });
});
