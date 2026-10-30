import { normalizeReviewBotLogin } from './lib.mjs';

const kinds = ['code', 'security'];
const sha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const requestId = (value) =>
  value === null ||
  (Number.isSafeInteger(value) && value > 0) ||
  (typeof value === 'string' && /^[1-9]\d*$/.test(value));

export function isReviewBot(comment, login) {
  return (
    comment.user?.type === 'Bot' &&
    typeof comment.user.login === 'string' &&
    comment.user.login.toLowerCase().replace(/\[bot\]$/, '') ===
      normalizeReviewBotLogin(login)
  );
}

export function parseReviewMarker(body, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...body.matchAll(
      new RegExp(`<!--\\s*${escaped}\\s+([\\s\\S]*?)\\s*-->`, 'g'),
    ),
  ];
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error(`Duplicate ${marker} marker.`);
  try {
    const value = JSON.parse(matches[0][1]);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Expected an object.');
    return value;
  } catch (error) {
    throw new Error(`Invalid ${marker} JSON: ${error.message}`, {
      cause: error,
    });
  }
}

export function isTrustSurface(path) {
  return (
    /^(?:\.github\/|\.agents\/|scripts\/)/.test(path) ||
    [
      'AGENTS.md',
      'package.json',
      'package-lock.json',
      'manifest.json',
    ].includes(path)
  );
}

export function findingTitle(body) {
  return (body.split(/\r?\n/).find((line) => line.trim()) ?? '')
    .replace(/^[#*\s]+/, '')
    .replace(/\[P[0-3]\]\s*/i, '')
    .replace(/[*`]/g, '')
    .trim()
    .toLowerCase();
}

function completed(value) {
  return (
    value?.status === 'completed' &&
    typeof value.clean === 'boolean' &&
    requestId(value.requestId)
  );
}

export function checkReviewState({
  headSha,
  mergeable,
  state,
  isDraft,
  comments,
  threads,
  files,
  config,
  trustedRequest,
  now = Date.now(),
}) {
  const pending = [];
  const manual = [];
  if (!sha(headSha)) throw new Error('Missing current head SHA.');
  const marker = config.reviewStateMarker;
  const ordered = [...comments].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const requests = {};
  const receipts = [];
  let summary;
  try {
    for (const comment of ordered) {
      if (isReviewBot(comment, config.reviewBotLogin)) {
        const value = parseReviewMarker(comment.body, marker);
        if (value) summary = value;
        const receipt = parseReviewMarker(comment.body, `${marker}:receipt`);
        if (receipt) {
          if (
            !sha(receipt.headSha) ||
            !kinds.includes(receipt.kind) ||
            !completed(receipt)
          )
            throw new Error('Invalid review receipt schema.');
          receipts.push(receipt);
        }
      } else {
        if (!trustedRequest(comment)) continue;
        const request = parseReviewMarker(comment.body, `${marker}:request`);
        if (!request) continue;
        if (
          !sha(request.headSha) ||
          !kinds.includes(request.kind) ||
          comment.id === null ||
          !requestId(comment.id) ||
          !comment.body.startsWith(
            `${config.reviewTriggers[kinds.indexOf(request.kind)]}\n\n<!--`,
          ) ||
          !Number.isFinite(Date.parse(comment.created_at))
        )
          throw new Error('Invalid review request schema.');
        if (request.headSha === headSha) requests[request.kind] = comment;
      }
    }
    if (
      summary &&
      (!sha(summary.headSha) ||
        !summary.reviews ||
        kinds.some(
          (kind) =>
            !['pending', 'running', 'completed', 'failed'].includes(
              summary.reviews[kind]?.status,
            ) ||
            (summary.reviews[kind].status === 'completed' &&
              !completed(summary.reviews[kind])),
        ))
    )
      throw new Error('Invalid or incomplete review summary schema.');
  } catch (error) {
    return { exitCode: 1, reasons: [error.message] };
  }
  const sensitive = files.some(
    (file) =>
      isTrustSurface(file.filename ?? file) ||
      (file.previous_filename && isTrustSurface(file.previous_filename)),
  );
  for (const kind of kinds) {
    const request = requests[kind];
    const review = summary?.headSha === headSha ? summary.reviews[kind] : null;
    const id = request ? String(request.id) : null;
    const matchesId = (value) =>
      request ? String(value.requestId) === id : value.requestId === null;
    const receipt = receipts
      .filter(
        (value) =>
          value.kind === kind && value.headSha === headSha && matchesId(value),
      )
      .at(-1);
    const done =
      completed(review) &&
      matchesId(review) &&
      receipt &&
      receipt.clean === review.clean;
    if (!done) {
      const reason = `${kind} review has not completed on current head ${headSha}.`;
      if (request && now - Date.parse(request.created_at) >= 30 * 60 * 1000)
        manual.push(
          `${reason} Request exceeded 30 minutes; manual review required.`,
        );
      else pending.push(reason);
    } else if (kind === 'security' && sensitive && !review.clean) {
      pending.push(
        'Trust-surface changes require a clean security review; owner merge only.',
      );
    }
  }
  const findings = threads.flatMap((thread) => {
    const root = thread.comments[0];
    if (
      !root ||
      root.authorType !== 'Bot' ||
      root.author?.toLowerCase().replace(/\[bot\]$/, '') !==
        config.reviewBotLogin
    )
      return [];
    const reply = thread.comments
      .slice(1)
      .find(
        (comment) =>
          comment.authorType === 'User' &&
          comment.author &&
          comment.body?.trim(),
      );
    if (!reply)
      pending.push(
        `Reviewer finding needs a non-bot reply: ${root.path}: ${findingTitle(root.body)}`,
      );
    if (
      !root.path ||
      !findingTitle(root.body) ||
      !Number.isFinite(Date.parse(root.createdAt)) ||
      (reply && !Number.isFinite(Date.parse(reply.createdAt)))
    )
      pending.push(
        'Reviewer finding is missing file, title, or timestamps; cannot check review loops.',
      );
    return [{ ...root, reply }];
  });
  for (const finding of findings) {
    if (
      findings.some(
        (earlier) =>
          earlier !== finding &&
          earlier.reply &&
          earlier.path === finding.path &&
          findingTitle(earlier.body) === findingTitle(finding.body) &&
          Date.parse(finding.createdAt) > Date.parse(earlier.reply.createdAt),
      )
    )
      manual.push(
        `Review loop at ${finding.path}: ${findingTitle(finding.body)}; manual review required.`,
      );
  }
  if (state !== 'OPEN' || isDraft !== false || mergeable !== 'MERGEABLE')
    pending.push(
      `PR is not mergeable (state=${state}, draft=${isDraft}, mergeable=${mergeable}).`,
    );
  const reasons = [...new Set([...manual, ...pending])];
  return { exitCode: manual.length ? 3 : pending.length ? 1 : 0, reasons };
}
