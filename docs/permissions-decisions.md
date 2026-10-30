# Manifest permission decisions

New grants compared with the most recent reachable `v*` release tag require an exact
entry below and a reason. Without an earlier tag, the baseline is empty. Tags on the
current commit are excluded. Entries are `- ` followed by a backtick-quoted
`field:value`, then ` - reason`. Changed CSP strings need a new exact entry;
removing a CSP key requires `content_security_policy.<key>:<removed>`.
Reviewers must verify that the reason still applies; this file is not automatic approval.
New permissions can trigger store re-review and user-facing warnings.

## Initial extension grants

- `permissions:identity` - Own OAuth PKCE sign-in through the browser identity API.
- `permissions:storage` - Options and memory-backed session token/cache storage.
- `permissions:sidePanel` - Governance information in the browser side panel.
- `permissions:tabs` - Track the current Entra blade for the panel context.
- `host_permissions:https://graph.microsoft.com/*` - Delegated Microsoft Graph v1.0 requests.
- `host_permissions:https://login.microsoftonline.com/*` - Own sign-in and token exchange.
- `content_scripts.matches:https://entra.microsoft.com/*` - Watch blade navigation and inject the access-packages entry.
- `content_security_policy.extension_pages:script-src 'self'; object-src 'none'; connect-src https://graph.microsoft.com https://login.microsoftonline.com` - Local scripts only, no objects, and connections restricted to Graph and sign-in.
