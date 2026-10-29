import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig, resolveModel } from '../scripts/harness/config.mjs';
import config from '../.agents/harness.config.json';
import example from '../.agents/harness.local.example.json';

vi.mock('node:fs', () => ({ readFileSync: vi.fn() }));

let local;
beforeEach(() => {
  vi.clearAllMocks();
  local = {
    cli: 'agent-cli',
    reviewBotLogin: 'review-bot[bot]',
    models: Object.fromEntries(config.tasks.map((task) => [task, 'model-a'])),
  };
  readFileSync.mockImplementation((path) =>
    JSON.stringify(path.endsWith('harness.config.json') ? config : local),
  );
});

describe('runtime harness configuration', () => {
  it('keeps task routing public and identifying values local', () => {
    expect(config).not.toHaveProperty('models');
    expect(config).not.toHaveProperty('cli');
    expect(config).not.toHaveProperty('reviewBotLogin');
    expect(Object.keys(example.models)).toEqual(config.tasks);
    for (const value of [
      example.cli,
      example.reviewBotLogin,
      ...Object.values(example.models),
    ])
      expect(value).toMatch(/^<[^>]+>$/);
    const loaded = loadConfig({});
    expect(loaded).toMatchObject(local);
    for (const task of config.tasks)
      expect(resolveModel(task, loaded)).toBe('model-a');
  });

  it('lets environment variables override every local setting', () => {
    const env = {
      AGENT_CLI: 'other-agent.cmd',
      REVIEW_BOT_LOGIN: 'other-review-bot',
      AGENT_MODEL_IMPLEMENT: 'model-b',
      AGENT_MODEL_REVIEW: 'model-c',
      AGENT_MODEL_RETRO: 'model-d',
      AGENT_MODEL_ADDRESS_COMMENTS: 'model-e',
      AGENT_MODEL_TRIAGE: 'model-f',
    };
    const loaded = loadConfig(env);
    expect(loaded.cli).toBe(env.AGENT_CLI);
    expect(loaded.reviewBotLogin).toBe(env.REVIEW_BOT_LOGIN);
    expect(loaded.models).toEqual({
      implement: 'model-b',
      review: 'model-c',
      retro: 'model-d',
      addressComments: 'model-e',
      triage: 'model-f',
    });
  });

  it('supports environment-only setup but reports missing local values clearly', () => {
    readFileSync.mockImplementation((path) => {
      if (path.endsWith('harness.config.json')) return JSON.stringify(config);
      throw Object.assign(new Error('not found'), { code: 'ENOENT' });
    });
    expect(() => loadConfig({})).toThrow(/Create .*harness\.local\.json/);
    const loaded = loadConfig({
      AGENT_CLI: 'agent-cli',
      REVIEW_BOT_LOGIN: 'review-bot[bot]',
      AGENT_MODEL_IMPLEMENT: 'model-b',
    });
    expect(resolveModel('implement', loaded)).toBe('model-b');
    expect(() => resolveModel('review', loaded)).toThrow(
      /Create .*harness\.local\.json/,
    );
  });

  it('rejects placeholders, empty overrides, and shell metacharacters', () => {
    for (const cli of ['', '<agent-cli>', 'agent & command', '--agent'])
      expect(() => loadConfig({ AGENT_CLI: cli })).toThrow(/AGENT_CLI/);
    for (const login of ['', '<review-bot-login>', 'bot;command'])
      expect(() => loadConfig({ REVIEW_BOT_LOGIN: login })).toThrow(
        /REVIEW_BOT_LOGIN/,
      );
    for (const model of ['', '<implement-model-id>', 'model & command'])
      expect(() =>
        resolveModel('implement', loadConfig({ AGENT_MODEL_IMPLEMENT: model })),
      ).toThrow(/Invalid agent model.*Create/);
    delete local.cli;
    expect(() => loadConfig({})).toThrow(/Create .*harness\.local\.json/);
    local.cli = 'agent-cli';
    delete local.reviewBotLogin;
    expect(() => loadConfig({})).toThrow(/Create .*harness\.local\.json/);
  });

  it('reports malformed, unreadable, or non-object local files instead of ignoring them', () => {
    for (const error of [
      new SyntaxError('invalid JSON'),
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    ]) {
      readFileSync.mockImplementation((path) => {
        if (path.endsWith('harness.config.json')) return JSON.stringify(config);
        throw error;
      });
      expect(() => loadConfig({ AGENT_CLI: 'agent-cli' })).toThrow(
        /Cannot read .*harness\.local\.json/,
      );
    }
    readFileSync.mockImplementation((path) =>
      JSON.stringify(path.endsWith('harness.config.json') ? config : null),
    );
    expect(() => loadConfig({})).toThrow(/Invalid local configuration/);
  });
});
