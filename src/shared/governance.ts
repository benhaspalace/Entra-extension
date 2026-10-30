import type { AccessPackage, Assignment, Group, PimInstance } from './types';

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
  | { source: 'pim'; status: 'active' | 'eligible'; instances: PimInstance[] }
  | { source: 'nested' }
  | { source: 'dynamic'; rule: string }
  | { source: 'synced' }
  | { source: 'manual' };

const sameId = (left: string | undefined, right: string) =>
  left?.toLowerCase() === right.toLowerCase();

export function isCurrentPimMember(
  instance: PimInstance,
  now: number,
): boolean {
  return (
    instance.accessId === 'member' &&
    Date.parse(instance.startDateTime) <= now &&
    (instance.endDateTime === null || Date.parse(instance.endDateTime) > now)
  );
}

export interface MembershipEvidence {
  membership: 'direct' | 'nested' | 'eligible';
  pim: readonly PimInstance[];
  now: number;
}

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
  evidence?: MembershipEvidence,
): Governance {
  if (evidence?.membership === 'nested') return { source: 'nested' };
  const pim =
    evidence?.pim.filter(
      (instance) =>
        sameId(instance.groupId, group.id) &&
        sameId(instance.principalId, memberId) &&
        isCurrentPimMember(instance, evidence.now) &&
        instance.status ===
          (evidence.membership === 'eligible' ? 'eligible' : 'active'),
    ) ?? [];
  if (evidence?.membership === 'eligible') {
    if (!pim.length)
      throw new Error('Eligibility row has no current PIM eligibility.');
    return { source: 'pim', status: 'eligible', instances: pim };
  }
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
  if (pim.length) return { source: 'pim', status: 'active', instances: pim };
  if (group.groupTypes?.includes('DynamicMembership'))
    return {
      source: 'dynamic',
      rule: group.membershipRule ?? 'Rule unavailable',
    };
  if (group.onPremisesSyncEnabled) return { source: 'synced' };
  return { source: 'manual' };
}
