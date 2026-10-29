#!/usr/bin/env node
// Create or update the GitHub labels the agent harness uses. Safe to re-run.
import { spawnSync } from 'node:child_process';

const labels = [
  ['agent:ready', '0e8a16', 'Ready for an agent to pick up'],
  ['agent:in-progress', 'fbca04', 'An agent is working on it'],
  ['agent:in-review', '1d76db', 'Agent opened a PR; waiting for human review'],
  ['agent:needs-human', 'b60205', 'Agent got stuck; see the latest comment'],
  ['triage', 'd4c5f9', 'Filed automatically; needs a human to accept or close'],
  [
    'source:agent-review',
    'c5def5',
    'Found by the review agent outside the task scope',
  ],
  ['harness', '5319e7', 'Improvement to the agent harness itself'],
  [
    'needs-tenant-test',
    'f9d0c4',
    'Can only be verified in a live Entra tenant',
  ],
];

for (const [name, color, description] of labels) {
  const result = spawnSync(
    'gh',
    [
      'label',
      'create',
      name,
      '--color',
      color,
      '--description',
      description,
      '--force',
    ],
    { encoding: 'utf8' },
  );
  console.log(
    result.status === 0
      ? `ok  ${name}`
      : `ERR ${name}: ${result.stderr.trim()}`,
  );
}
