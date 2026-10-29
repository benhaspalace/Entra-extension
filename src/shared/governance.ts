import type { AccessPackage, Assignment, Group } from './types';

export interface PackageGrant {
  id: string;
  name: string;
  assignmentId: string;
  expiresAt: string | null;
  duration: string | null;
  startsAt: string | null;
}

export type Governance =
  | { source: 'access-package'; packages: PackageGrant[] }
  | { source: 'dynamic'; rule: string }
  | { source: 'synced' }
  | { source: 'manual' };

const sameId = (left: string | undefined, right: string) =>
  left?.toLowerCase() === right.toLowerCase();

export const ACTIVE_ASSIGNMENT_STATES = [
  'delivered',
  'partiallyDelivered',
  'delivering',
] as const;

export function isActiveAssignment(state: string): boolean {
  return ACTIVE_ASSIGNMENT_STATES.some((active) => active === state);
}

export function packageContainsGroup(
  pkg: AccessPackage,
  groupId: string,
): boolean {
  return (
    pkg.resourceRoleScopes?.some(
      ({ role, scope }) =>
        scope?.originSystem === 'AadGroup' &&
        sameId(scope.originId, groupId) &&
        (role?.originId?.startsWith('Member_') === true ||
          role?.displayName === 'Member'),
    ) ?? false
  );
}

export function classifyGovernance(
  group: Group,
  memberId: string,
  packages: readonly AccessPackage[],
  assignments: readonly Assignment[],
): Governance {
  const grants: PackageGrant[] = [];
  for (const pkg of packages) {
    if (!packageContainsGroup(pkg, group.id)) continue;
    for (const assignment of assignments) {
      if (
        !isActiveAssignment(assignment.state) ||
        !sameId(assignment.target?.objectId, memberId) ||
        !sameId(assignment.accessPackage?.id, pkg.id)
      )
        continue;
      const expiration = assignment.schedule?.expiration;
      grants.push({
        id: pkg.id,
        name: pkg.displayName,
        assignmentId: assignment.id,
        expiresAt: expiration?.endDateTime ?? null,
        duration:
          expiration?.type === 'afterDuration'
            ? (expiration.duration ?? null)
            : null,
        startsAt: assignment.schedule?.startDateTime ?? null,
      });
    }
  }
  if (grants.length) return { source: 'access-package', packages: grants };
  if (group.groupTypes?.includes('DynamicMembership'))
    return {
      source: 'dynamic',
      rule: group.membershipRule ?? 'Rule unavailable',
    };
  if (group.onPremisesSyncEnabled) return { source: 'synced' };
  return { source: 'manual' };
}
