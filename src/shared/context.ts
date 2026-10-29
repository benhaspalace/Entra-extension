export type EntraContext = { kind: 'group' | 'user'; id: string };

export const GUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseContext(href: string): EntraContext | null {
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
  const parts = hash.replace(/^#/, '').split('/');
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
