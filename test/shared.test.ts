import { afterEach, describe, expect, it, vi } from 'vitest';
import { memberLink, packageLink } from '../src/shared/links';
import { authorizationCode, base64Url, createPkce } from '../src/shared/pkce';
import {
  authScopes,
  settingsKey,
  validateSettings,
} from '../src/shared/settings';
import { errorMessage, request } from '../src/shared/messages';

const settings = {
  tenantId: '12345678-1234-4abc-8def-123456789abc',
  clientId: '87654321-4321-4abc-8def-123456789abc',
  auditEnabled: true,
};
afterEach(() => vi.unstubAllGlobals());

describe('links', () => {
  it('builds central portal deep links with escaped identifiers', () => {
    expect(packageLink('a/b')).toBe(
      'https://entra.microsoft.com/#view/Microsoft_Azure_ELMAdmin/EntitlementMenuBlade/~/overview/entitlementId/a%2Fb',
    );
    expect(memberLink('user', 'id')).toContain(
      'UserProfileMenuBlade/~/overview/userId/id',
    );
    expect(memberLink('group', 'id')).toContain(
      'GroupDetailsMenuBlade/~/Overview/groupId/id',
    );
  });
});

describe('PKCE', () => {
  it('generates independent verifier/state and an S256 challenge', async () => {
    const first = await createPkce();
    const second = await createPkce();
    expect(first.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(first.verifier).not.toBe(first.state);
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).toBe(
      base64Url(
        new Uint8Array(
          await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(first.verifier),
          ),
        ),
      ),
    );
    expect(base64Url(new Uint8Array([255, 254, 253]))).toBe('__79');
  });
  it('validates callback origin, path, state and authorization errors', () => {
    const redirect = 'https://extension.chromiumapp.org/';
    expect(
      authorizationCode(`${redirect}?state=state&code=code`, redirect, 'state'),
    ).toBe('code');
    for (const callback of [
      'https://evil.example/?state=state&code=code',
      `${redirect}other?state=state&code=code`,
      `${redirect}?state=wrong&code=code`,
      `${redirect}?state=state&error=access_denied`,
      `${redirect}?state=state`,
    ])
      expect(() => authorizationCode(callback, redirect, 'state')).toThrow();
  });
});

describe('settings and messages', () => {
  it('validates and normalizes GUIDs and rejects configuration injection', () => {
    expect(
      validateSettings({
        ...settings,
        tenantId: ` ${settings.tenantId.toUpperCase()} `,
      }),
    ).toEqual(settings);
    expect(settingsKey(settings)).toBe(
      `${settings.tenantId}:${settings.clientId}:true`,
    );
    for (const input of [
      null,
      {},
      { ...settings, clientId: '../common' },
      { ...settings, tenantId: 'common' },
      { ...settings, auditEnabled: 'yes' },
    ]) {
      expect(() => validateSettings(input)).toThrow('Configure');
    }
  });
  it('requests least-privilege delegated scopes and optional audit consent', () => {
    expect(authScopes(settings)).toContain('offline_access');
    expect(authScopes(settings)).toContain(
      'https://graph.microsoft.com/PrivilegedAssignmentSchedule.Read.AzureADGroup',
    );
    expect(authScopes(settings)).toContain(
      'https://graph.microsoft.com/PrivilegedEligibilitySchedule.Read.AzureADGroup',
    );
    expect(authScopes(settings)).toContain(
      'https://graph.microsoft.com/AuditLog.Read.All',
    );
    expect(authScopes({ ...settings, auditEnabled: false })).not.toContain(
      'AuditLog.Read.All',
    );
    expect(authScopes(settings)).not.toContain('Directory.ReadWrite');
  });
  it('surfaces background errors and successful typed responses', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: 'token' })
      .mockResolvedValueOnce({ ok: false, error: 'Sign in again' })
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    expect(await request('getToken', { refresh: false })).toBe('token');
    await expect(request('getToken', { refresh: false })).rejects.toThrow(
      'Sign in again',
    );
    await expect(request('authStatus', undefined)).rejects.toThrow(
      'unavailable',
    );
    expect(errorMessage(new Error('problem'))).toBe('problem');
    expect(errorMessage(null)).toContain('unexpected');
  });
});
