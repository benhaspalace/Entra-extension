import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../scripts/harness/process.mjs';
import { runCopilot } from '../scripts/harness/copilot.mjs';

vi.mock('node:fs', () => ({
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock('../scripts/harness/process.mjs', () => ({ run: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  readFileSync.mockReturnValue(
    '{"models":{"implement":"gpt-6.1-sol","review":"claude-opus-5.5"}}',
  );
  run.mockReturnValue({ ok: true, stdout: 'reply', output: 'reply\nstderr' });
});

describe('shared Copilot runner', () => {
  it('writes prompt and combined reply, invokes the configured model, and returns all output', () => {
    expect(
      runCopilot({ role: 'test-1', task: 'implement', prompt: 'Do the work.' }),
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
    const [, args, options] = run.mock.calls[0];
    expect(args.slice(0, 2)).toEqual(['--model', 'gpt-6.1-sol']);
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
    runCopilot({
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

  it('writes preview artifacts without invoking Copilot in a dry run', () => {
    expect(
      runCopilot({
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

  it('returns failures with their reply artifacts and rejects unsafe roles', () => {
    run.mockReturnValue({ ok: false, stdout: '', output: 'CLI unavailable' });
    expect(
      runCopilot({ role: 'failure', task: 'implement', prompt: 'Work.' }).ok,
    ).toBe(false);
    expect(writeFileSync).toHaveBeenCalledWith(
      join('.agents', 'tmp', 'failure-reply.md'),
      'CLI unavailable',
    );
    expect(() =>
      runCopilot({ role: '..\\escape', task: 'implement', prompt: '' }),
    ).toThrow(/safe file name/);
  });

  it('does not silently default invalid overrides or allow them to invent tasks', () => {
    expect(() =>
      runCopilot({
        role: 'invalid',
        task: 'implement',
        prompt: '',
        model: '',
      }),
    ).toThrow(/Invalid Copilot model/);
    expect(() =>
      runCopilot({
        role: 'unknown',
        task: 'unknown',
        prompt: '',
        model: 'gpt-6.1-sol',
      }),
    ).toThrow(/No Copilot model/);
    expect(run).not.toHaveBeenCalled();
  });
});
