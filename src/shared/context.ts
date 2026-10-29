export type EntraContext = { kind: 'group' | 'user'; id: string };

export const GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseContext(href: string): EntraContext | null {
  const parts = routeParts(href);
  if (!parts) return null;
  for (const [blade, section, key, kind] of [
    ['GroupDetailsMenuBlade', 'Members', 'groupId', 'group'],
    ['UserProfileMenuBlade', 'Groups', 'userId', 'user'],
  ] as const) {
    const bladeIndex = parts.findIndex(
      (part) => part.toLowerCase() === blade.toLowerCase(),
    );
    if (
      bladeIndex < 0 ||
      parts[bladeIndex + 1] !== '~' ||
      parts[bladeIndex + 2]?.toLowerCase() !== section.toLowerCase()
    )
      continue;
    const keyIndex = parts.findIndex(
      (part, index) =>
        index > bladeIndex + 2 && part.toLowerCase() === key.toLowerCase(),
    );
    const id = parts[keyIndex + 1];
    if (keyIndex >= 0 && id && GUID.test(id))
      return { kind, id: id.toLowerCase() };
  }
  return null;
}

export function parseUserProfile(href: string): string | null {
  const parts = routeParts(href);
  if (!parts) return null;
  if (
    parts[0]?.toLowerCase() !== 'view' ||
    parts[1]?.toLowerCase() !== 'microsoft_aad_usersandtenants' ||
    parts[2]?.toLowerCase() !== 'userprofilemenublade' ||
    parts[3] !== '~' ||
    !parts[4]
  )
    return null;
  const keyIndex = parts.findIndex(
    (part, index) => index > 4 && part.toLowerCase() === 'userid',
  );
  const id = parts[keyIndex + 1];
  return keyIndex >= 0 && id && GUID.test(id) ? id.toLowerCase() : null;
}

function routeParts(href: string): string[] | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== 'https://entra.microsoft.com') return null;
  let hash = url.hash;
  for (let depth = 0; depth < 4; depth++) {
    try {
      const decoded = decodeURIComponent(hash);
      if (decoded === hash) break;
      hash = decoded;
    } catch {
      return null;
    }
  }
  return hash.replace(/^#/, '').split('/');
}
