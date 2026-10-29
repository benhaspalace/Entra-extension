import { GUID } from './context';

export interface Settings {
  tenantId: string;
  clientId: string;
  auditEnabled: boolean;
}

export function validateSettings(value: unknown): Settings {
  if (
    !value ||
    typeof value !== 'object' ||
    !('tenantId' in value) ||
    typeof value.tenantId !== 'string' ||
    !GUID.test(value.tenantId.trim()) ||
    !('clientId' in value) ||
    typeof value.clientId !== 'string' ||
    !GUID.test(value.clientId.trim()) ||
    !('auditEnabled' in value) ||
    typeof value.auditEnabled !== 'boolean'
  )
    throw new Error(
      'Configure valid tenant and client GUIDs in Options first.',
    );
  return {
    tenantId: value.tenantId.trim().toLowerCase(),
    clientId: value.clientId.trim().toLowerCase(),
    auditEnabled: value.auditEnabled,
  };
}

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.sync.get('settings');
  return validateSettings(stored.settings);
}

export function settingsKey(settings: Settings): string {
  return `${settings.tenantId}:${settings.clientId}:${settings.auditEnabled}`;
}

export function authScopes(settings: Settings): string {
  return [
    'openid',
    'profile',
    'offline_access',
    'https://graph.microsoft.com/User.Read',
    'https://graph.microsoft.com/GroupMember.Read.All',
    'https://graph.microsoft.com/EntitlementManagement.Read.All',
    ...(settings.auditEnabled
      ? ['https://graph.microsoft.com/AuditLog.Read.All']
      : []),
  ].join(' ');
}
