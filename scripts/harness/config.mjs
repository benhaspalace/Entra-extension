import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL_PATH = join('.agents', 'harness.local.json');
const guidance = `Create ${LOCAL_PATH} from .agents/harness.local.example.json and replace its placeholders, or set the corresponding environment variable.`;

export function resolveModel(task, config) {
  if (!config.tasks?.includes(task))
    throw new Error(`Unknown agent task: ${task}`);
  const model = config.models?.[task];
  if (model === undefined)
    throw new Error(`No agent model configured for task: ${task}. ${guidance}`);
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._-]+$/.test(model))
    throw new Error(`Invalid agent model for task: ${task}. ${guidance}`);
  return model;
}

export function loadLocalConfig() {
  let local = {};
  try {
    local = JSON.parse(readFileSync(LOCAL_PATH, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error(`Cannot read ${LOCAL_PATH}: ${error.message}`, {
        cause: error,
      });
  }
  if (!local || typeof local !== 'object' || Array.isArray(local))
    throw new Error(`Invalid local configuration. ${guidance}`);
  if (
    local.forbiddenTerms !== undefined &&
    (!Array.isArray(local.forbiddenTerms) ||
      local.forbiddenTerms.some(
        (term) => typeof term !== 'string' || !term.trim(),
      ))
  )
    throw new Error('forbiddenTerms must be a list of nonempty strings.');
  return local;
}

export function loadConfig(env = process.env) {
  const config = JSON.parse(
    readFileSync(join('.agents', 'harness.config.json'), 'utf8'),
  );
  const local = loadLocalConfig();
  const cli = env.AGENT_CLI ?? local.cli;
  const reviewBotLogin = env.REVIEW_BOT_LOGIN ?? local.reviewBotLogin;
  if (typeof cli !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(cli))
    throw new Error(`Missing or invalid agent CLI (AGENT_CLI). ${guidance}`);
  if (
    typeof reviewBotLogin !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]*(?:\[bot\])?$/.test(reviewBotLogin)
  )
    throw new Error(
      `Missing or invalid review bot login (REVIEW_BOT_LOGIN). ${guidance}`,
    );
  const models = Object.fromEntries(
    config.tasks.map((task) => {
      const suffix = task.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase();
      return [task, env[`AGENT_MODEL_${suffix}`] ?? local.models?.[task]];
    }),
  );
  return {
    ...config,
    cli,
    reviewBotLogin,
    models,
    forbiddenTerms: local.forbiddenTerms ?? [],
  };
}
