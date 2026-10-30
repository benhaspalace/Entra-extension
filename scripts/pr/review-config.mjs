import { loadLocalConfig } from '../harness/config.mjs';
import { normalizeReviewBotLogin } from './lib.mjs';

export function reviewSettings(local = loadLocalConfig(), env = process.env) {
  const reviewBotLogin = normalizeReviewBotLogin(
    env.REVIEW_BOT_LOGIN ?? local.reviewBotLogin,
  );
  const reviewTriggers =
    env.REVIEW_TRIGGERS === undefined
      ? local.reviewTriggers
      : JSON.parse(env.REVIEW_TRIGGERS);
  const reviewStateMarker = env.REVIEW_STATE_MARKER ?? local.reviewStateMarker;
  if (
    !Array.isArray(reviewTriggers) ||
    reviewTriggers.length !== 2 ||
    reviewTriggers.some(
      (value) =>
        typeof value !== 'string' || !value.trim() || /[\r\n]/.test(value),
    ) ||
    reviewTriggers[0] === reviewTriggers[1]
  )
    throw new Error(
      'Configure reviewTriggers as two distinct single-line triggers (code, security).',
    );
  if (
    typeof reviewStateMarker !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/.test(reviewStateMarker)
  )
    throw new Error(
      'Configure reviewStateMarker in .agents/harness.local.json or REVIEW_STATE_MARKER.',
    );
  return {
    reviewBotLogin,
    reviewTriggers: [...reviewTriggers],
    reviewStateMarker,
  };
}

export function reviewMarker(marker, value) {
  return `<!-- ${marker} ${JSON.stringify(value)} -->`;
}
