import type { DirectoryAudit } from './types';

export interface AuditAttribution {
  actor: string;
  when: string;
  historicalPackage: boolean;
}

function propertyId(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const decoded: unknown = JSON.parse(value);
    return typeof decoded === 'string' ? decoded.toLowerCase() : null;
  } catch {
    return value.toLowerCase();
  }
}

export function matchAudit(
  events: readonly DirectoryAudit[],
  groupId: string,
  memberId: string,
): AuditAttribution | null {
  const group = groupId.toLowerCase();
  const member = memberId.toLowerCase();
  const matches = events.filter((event) => {
    if (
      event.activityDisplayName !== 'Add member to group' ||
      event.result !== 'success' ||
      !event.activityDateTime ||
      !Number.isFinite(Date.parse(event.activityDateTime))
    )
      return false;
    const targets = event.targetResources ?? [];
    const hasMember = targets.some(
      (target) => target.id?.toLowerCase() === member,
    );
    const hasGroup = targets.some(
      (target) =>
        target.id?.toLowerCase() === group ||
        target.modifiedProperties?.some(
          (property) =>
            property.displayName?.toLowerCase() === 'group.objectid' &&
            propertyId(property.newValue) === group,
        ),
    );
    return hasMember && hasGroup;
  });
  matches.sort(
    (left, right) =>
      Date.parse(right.activityDateTime ?? '') -
      Date.parse(left.activityDateTime ?? ''),
  );
  const event = matches[0];
  if (!event?.activityDateTime) return null;
  const app = event.initiatedBy?.app;
  const actor =
    event.initiatedBy?.user?.userPrincipalName ??
    event.initiatedBy?.user?.displayName ??
    app?.displayName ??
    'Unknown actor';
  return {
    actor,
    when: event.activityDateTime,
    historicalPackage:
      !!app &&
      (/entitlement management|identity governance/i.test(
        app.displayName ?? '',
      ) ||
        app.appId?.toLowerCase() === '810dcf14-1858-4bf2-8134-4c369fa3235b'),
  };
}
