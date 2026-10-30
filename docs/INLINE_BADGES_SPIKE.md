# Members-grid inline badges: feasibility spike (#6)

## Status: blocked on live DOM evidence

No authenticated Entra browser session or live Members-grid DOM capture was
available for this investigation (2026-10-30). The grid's actual frame, origin,
row structure and virtualisation behaviour are **not verified**. The iframe
description in `PLAN.md` is a hypothesis, not a result of this spike.

Do not treat this document as completion of the live-DOM acceptance criterion.
Inline badges remain unimplemented; there is no option to enable them, no new
host permission and no change to the side panel. Implementing speculative
selectors or granting wildcard portal access would not establish feasibility.

## Issue and PR handoff

Refs #6. This is a partial investigation, not a completed feasibility spike;
both acceptance criteria remain unchecked. Any PR carrying this document must
use `Refs #6`, not an automatic issue-closing keyword.

The maintainer must keep #6 open and mark it `agent:needs-human` pending an
authorized test-tenant inspection. No issue label or PR metadata was changed
as part of this local-only investigation. An authorized tester must perform the
live check below and record the inspection date, browser version, observed
origin, frame chain, row/cell selectors and content-script reachability conclusion
in this document before the spike criterion can be marked complete. Until then,
do not close #6 or describe phase 2 as delivered.

## What the repository establishes

| Surface | Verified from source | Consequence |
| --- | --- | --- |
| `manifest.json` | The content script matches only `https://entra.microsoft.com/*`; `all_frames` is omitted (defaults to false). | It runs in the top document, not a blade's child frame. |
| `src/content/index.ts` | Watches navigation and updates the user profile menu. | There is no Members-grid discovery or injection. |
| `src/shared/settings.ts` | Settings contain tenant ID, client ID and the audit option. | There is no inline-badge preference; the feature is effectively off. |
| `src/sidepanel/panel.ts` | Loaded membership rows stay in panel memory. | Content scripts cannot already consume those rows. |
| `src/shared/messages.ts` | No membership-snapshot message exists. | A future implementation needs a deliberately scoped data bridge, not another Graph fetch from the page. |
| `test/fixtures` | Contains a user-menu fixture, but no Members-grid fixture. | The menu fixture cannot prove grid reachability or row matching. |

A top-frame script cannot traverse a cross-origin frame's document. If the grid
is cross-origin, the current script cannot reach it. A separately matched
content script running inside that frame could potentially do so, but would need
the observed origin and `all_frames: true`; enabling `all_frames` alone does not
make another origin match. DevTools' ability to inspect a child frame is not
proof that the current content script has access to it.

## Required live check

Use an authorized test tenant and the unpacked extension from `dist`. Do not
inspect portal storage, cookies, tokens or network authorization headers. Do not
save real member names, UPNs, tenant IDs or group IDs in repository fixtures.

1. Open a group's **Members** blade on `entra.microsoft.com`. In DevTools Elements,
   select a visible member's name cell. In the Console execution-context picker,
   select the frame owning that cell. Record `location.origin` in that context
   (not the full tenant-specific URL), whether it is the top frame, browser
   version and inspection date. If there are nested frames, record the chain.
   Record whether the row is in ordinary DOM, an open shadow root or an
   inaccessible closed shadow root.
2. Inspect the frame element from its parent document. Record its origin and
   relevant sandbox attributes. In the **top** context, verify whether that
   specific frame's `contentDocument` is readable; record null/access-denied
   results without attempting a same-origin-policy bypass. For a cross-origin
   candidate, a later narrowly matched probe must demonstrate access from the
   extension's isolated content-script world inside the frame.
3. Record the observed row and name/UPN cell selectors, preferring semantic roles
   and stable attributes over generated classes. Note whether UPN is present
   without hovering or making additional requests. Capture only a small,
   anonymized DOM excerpt retaining the relevant roles/attributes. Include two
   rows with the same display name, a row with no UPN and a non-user member.
4. Scroll far enough to replace visible rows, then sort, filter and change
   groups. Record whether row nodes are recycled, which text/attributes change,
   and whether the blade/frame itself is replaced. Check portal navigation back
   to Members as well. A selector working for the initial viewport is not enough.
5. Record a conclusion with the exact reachable origin, frame and selectors, or
   a concrete reason injection is infeasible. Until that evidence exists, keep
   feasibility **unknown** and leave badges off.

## Implementation gate if the grid proves reachable

Retain the side panel, independent PKCE sign-in and Graph v1.0 architecture.
Before shipping, agree any additional frame access and row-injection surface
with the restrictions in `AGENTS.md`; current rules only cover shell-menu clones
and a closed-shadow drawer. Do not silently relax those restrictions.

The option must be off by default. Share only already-loaded governance results,
bound to the originating tab, group and extension sign-in session through the
background worker. Never expose tokens or session storage to content scripts,
trust page messages as extension messages, or perform new Graph calls from a
content script. Clear snapshots and badges on navigation, reload, sign-out,
settings changes and option disablement; reject late responses for old contexts.

Matching must be a pure, unit-tested function. Prefer an exact normalized UPN;
use an exact display name only when it uniquely identifies a loaded member and
the visible row supplies no conflicting identity. Missing, ambiguous or
conflicting identity means **no badge**, not "Manual". Do not use substring
matches or infer a governance source from missing data. Handle non-user members
conservatively and never classify again in the content script.

Use text nodes and isolated, marked, idempotent UI. Recycled rows must lose old
badges before being rematched; observe identity text/attribute changes as well
as inserted rows. Unsupported DOM must inject nothing, leaving the panel usable.
Test matching ambiguity, context/session isolation, stale replies, disabling,
row reuse and cleanup with anonymized live-derived fixtures. Finally repeat the
live scroll/navigation checks with the option both off and on.
