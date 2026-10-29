const PORTAL = 'https://entra.microsoft.com/#view/';

export function packageLink(id: string): string {
  return `${PORTAL}Microsoft_Azure_ELMAdmin/EntitlementMenuBlade/~/overview/entitlementId/${encodeURIComponent(id)}`;
}

export function memberLink(kind: 'group' | 'user', id: string): string {
  return kind === 'group'
    ? `${PORTAL}Microsoft_AAD_IAM/GroupDetailsMenuBlade/~/Overview/groupId/${encodeURIComponent(id)}`
    : `${PORTAL}Microsoft_AAD_UsersAndTenants/UserProfileMenuBlade/~/overview/userId/${encodeURIComponent(id)}`;
}
