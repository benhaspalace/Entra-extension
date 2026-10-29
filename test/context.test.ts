import { describe, expect, it } from 'vitest';
import { parseContext, parseUserProfile } from '../src/shared/context';

const ID = '12345678-1234-4abc-8def-123456789abc';
const groupHash = `view/Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Members/groupId/${ID}`;
const userHash = `view/Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/Groups/userId/${ID}`;

describe('Entra context parsing', () => {
  it.each([
    ['group', groupHash],
    ['user', userHash],
    ['group', encodeURIComponent(groupHash)],
    ['user', encodeURIComponent(encodeURIComponent(userHash))],
    [
      'group',
      groupHash.replace(ID, ID.toUpperCase()).replace('Members', 'members'),
    ],
    ['group', `${groupHash}/extra/value`],
  ])('parses %s context: %s', (kind, hash) => {
    expect(parseContext(`https://entra.microsoft.com/#${hash}`)).toEqual({
      kind,
      id: ID,
    });
  });

  it.each([
    'not a URL',
    `https://evil.example/#${groupHash}`,
    `http://entra.microsoft.com/#${groupHash}`,
    `https://entra.microsoft.com.evil.example/#${groupHash}`,
    `https://entra.microsoft.com/#${groupHash.replace('Members', 'Overview')}`,
    `https://entra.microsoft.com/#${userHash.replace('Groups', 'overview')}`,
    `https://entra.microsoft.com/#${groupHash.replace(ID, 'not-a-guid')}`,
    `https://entra.microsoft.com/#${groupHash.replace('groupId/', '')}`,
    `https://entra.microsoft.com/#${groupHash}%ZZ`,
    `https://entra.microsoft.com/?groupId=${ID}`,
    `https://entra.microsoft.com/#groupId/${ID}`,
  ])('rejects unsupported or malformed URL %s', (url) => {
    expect(parseContext(url)).toBeNull();
  });
});

describe('user profile menu context', () => {
  it.each(['overview', 'Groups', 'anything', 'CustomSecurityAttributes'])(
    'accepts the %s user profile section',
    (section) => {
      const hash = userHash.replace('Groups', section);
      for (const route of [
        hash,
        encodeURIComponent(hash),
        encodeURIComponent(encodeURIComponent(hash)),
      ])
        expect(parseUserProfile(`https://entra.microsoft.com/#${route}`)).toBe(
          ID,
        );
      expect(
        parseUserProfile(
          `https://entra.microsoft.com/#${hash.replace(ID, ID.toUpperCase())}`,
        ),
      ).toBe(ID);
    },
  );

  it.each([
    'not a URL',
    `https://evil.example/#${userHash}`,
    `https://entra.microsoft.com/#${groupHash}`,
    `https://entra.microsoft.com/#${userHash.replace(ID, 'bad-id')}`,
    `https://entra.microsoft.com/#${userHash.replace('userId/', '')}`,
    `https://entra.microsoft.com/#${userHash.replace('Microsoft_AAD_UsersAndTenants', 'Other')}`,
    `https://entra.microsoft.com/#${userHash.replace('view/', 'blade/')}`,
    `https://entra.microsoft.com/#${userHash}%ZZ`,
    `https://entra.microsoft.com/#${userHash.replace('~/Groups', 'Groups')}`,
  ])('does not inject on unsupported routes: %s', (url) => {
    expect(parseUserProfile(url)).toBeNull();
  });
});
