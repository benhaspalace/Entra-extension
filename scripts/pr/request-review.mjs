import { pathToFileURL } from 'node:url';
import { gh, run } from '../harness/process.mjs';
import { repository } from './github.mjs';
import { parsePrArgs } from './lib.mjs';
import { reviewMarker, reviewSettings } from './review-config.mjs';

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function requestReview(
  pr,
  {
    config = reviewSettings(),
    repo = repository(),
    expectedHead,
    previousHead,
    wait = sleep,
  } = {},
) {
  const delays = [1000, 2000, 4000, 8000, 15000];
  let head;
  for (let attempt = 0; ; attempt++) {
    head = JSON.parse(
      gh(['pr', 'view', String(pr), '--json', 'headRefOid']).stdout,
    ).headRefOid;
    if (!/^[a-f0-9]{40}$/.test(head ?? ''))
      throw new Error('GitHub did not return a valid PR head SHA.');
    if (!expectedHead || head === expectedHead) break;
    if (previousHead && head !== previousHead)
      throw new Error(
        'PR head changed before requesting reviews; rerun for the new head.',
      );
    if (attempt === delays.length)
      throw new Error(
        'PR head changed or did not update to the pushed SHA within 30 seconds; no reviews requested.',
      );
    wait(delays[attempt]);
  }
  for (const [index, kind] of ['code', 'security'].entries()) {
    const body = `${config.reviewTriggers[index]}\n\n${reviewMarker(`${config.reviewStateMarker}:request`, { headSha: head, kind })}`;
    // Explicit, trusted local triggers are control messages, not publishable agent prose.
    // Keep this narrow exception out of the general GitHub text-policy boundary.
    run(
      'gh',
      [
        'api',
        `repos/${repo.owner.login}/${repo.name}/issues/${pr}/comments`,
        '--method',
        'POST',
        '--input',
        '-',
      ],
      { input: JSON.stringify({ body }) },
    );
  }
  console.log(`Requested code and security reviews for PR #${pr} at ${head}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  requestReview(parsePrArgs(process.argv.slice(2)).pr);
