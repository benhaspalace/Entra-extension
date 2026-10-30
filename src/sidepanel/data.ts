import type { EntraContext } from '../shared/context';
import {
  classifyGovernance,
  isCurrentPimMember,
  packageContainsGroup,
  type Governance,
  type MembershipEvidence,
} from '../shared/governance';
import type { GraphClient } from '../shared/graph';
import {
  ENTITLEMENTS,
  PACKAGE_SCOPE,
  loadPackages,
  mapLimited,
} from '../shared/packages';
import type {
  Assignment,
  DirectoryObject,
  Group,
  PimInstance,
} from '../shared/types';

const GROUP_SELECT =
  'id,displayName,groupTypes,membershipRule,onPremisesSyncEnabled';
const GROUP_SCOPE = 'GroupMember.Read.All';
// Graph documents only `eq` on state, so active states are filtered client-side
// by classifyGovernance rather than with an `or` filter.

export interface MembershipRow {
  member: DirectoryObject;
  group: Group;
  governance: Governance;
  membership: MembershipEvidence['membership'];
  eligibility: PimInstance[];
}

export interface MembershipData {
  title: string;
  rows: MembershipRow[];
}

async function loadPim(
  context: EntraContext,
  graph: GraphClient,
  signal: AbortSignal,
): Promise<PimInstance[]> {
  const filter = `${context.kind === 'group' ? 'groupId' : 'principalId'} eq '${context.id}'`;
  const lists = await Promise.all(
    (['active', 'eligible'] as const).map(async (status) => {
      const endpoint =
        status === 'active'
          ? 'assignmentScheduleInstances'
          : 'eligibilityScheduleInstances';
      const scope =
        status === 'active'
          ? 'PrivilegedAssignmentSchedule.Read.AzureADGroup'
          : 'PrivilegedEligibilitySchedule.Read.AzureADGroup';
      const instances = await graph.list<Omit<PimInstance, 'status'>>(
        `/identityGovernance/privilegedAccess/group/${endpoint}?$filter=${encodeURIComponent(filter)}&$expand=${context.kind === 'group' ? 'principal' : 'group'}`,
        scope,
        signal,
      );
      return instances.map((instance) => ({ ...instance, status }));
    }),
  );
  return lists.flat();
}

function candidates<T extends DirectoryObject>(
  direct: T[],
  transitive: T[],
  eligible: T[],
): { subject: T; membership: MembershipEvidence['membership'] }[] {
  const result = new Map<
    string,
    { subject: T; membership: MembershipEvidence['membership'] }
  >();
  for (const [membership, subjects] of [
    ['direct', direct],
    ['nested', transitive],
    ['eligible', eligible],
  ] as const) {
    for (const subject of subjects) {
      const key = subject.id.toLowerCase();
      if (!result.has(key)) result.set(key, { subject, membership });
    }
  }
  return [...result.values()];
}

export async function loadMembership(
  context: EntraContext,
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<MembershipData> {
  const packages = await loadPackages(graph, sessionId, signal);
  if (context.kind === 'group') {
    const [group, members, transitive, pim] = await Promise.all([
      graph.graphFetch<Group>(
        `/groups/${context.id}?$select=${GROUP_SELECT}`,
        GROUP_SCOPE,
        signal,
      ),
      graph.list<DirectoryObject>(
        `/groups/${context.id}/members?$select=id,displayName,userPrincipalName,mail&$top=999`,
        GROUP_SCOPE,
        signal,
      ),
      graph.list<DirectoryObject>(
        `/groups/${context.id}/transitiveMembers?$select=id,displayName,userPrincipalName,mail&$top=999&$count=true`,
        GROUP_SCOPE,
        signal,
      ),
      loadPim(context, graph, signal),
    ]);
    const assignmentLists = await mapLimited(
      packages.filter((pkg) => packageContainsGroup(pkg, group.id)),
      4,
      async (pkg) => {
        const assignments = await graph.list<Assignment>(
          `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`accessPackage/id eq '${pkg.id}'`)}&$expand=target&$select=id,state,schedule`,
          PACKAGE_SCOPE,
          signal,
        );
        return assignments.map((assignment) => ({
          ...assignment,
          accessPackage: { id: pkg.id },
        }));
      },
    );
    const assignments = assignmentLists.flat();
    const now = Date.now();
    const eligibility = pim.filter(
      (instance) =>
        instance.status === 'eligible' &&
        instance.groupId.toLowerCase() === group.id.toLowerCase() &&
        isCurrentPimMember(instance, now),
    );
    return {
      title: `${group.displayName ?? group.id} - Members`,
      rows: candidates(
        members,
        transitive,
        eligibility.map((instance) => ({
          ...instance.principal,
          id: instance.principalId,
        })),
      ).map(({ subject: member, membership }) => ({
        member,
        membership,
        group,
        eligibility: eligibility.filter(
          (instance) =>
            instance.principalId.toLowerCase() === member.id.toLowerCase(),
        ),
        governance: classifyGovernance(
          group,
          member.id,
          packages,
          assignments,
          { membership, pim, now },
        ),
      })),
    };
  }
  const [profile, groups, assignments, transitive, pim] = await Promise.all([
    // Reading another user's profile needs User.ReadBasic.All, which is not
    // requested, so the name is optional and the title falls back to the id.
    graph
      .graphFetch<DirectoryObject>(
        `/users/${context.id}?$select=displayName,userPrincipalName`,
        GROUP_SCOPE,
        signal,
      )
      .catch((error: unknown) => {
        if (signal.aborted) throw error;
        return null;
      }),
    graph.list<Group>(
      `/users/${context.id}/memberOf/microsoft.graph.group?$select=${GROUP_SELECT}&$count=true`,
      GROUP_SCOPE,
      signal,
    ),
    graph.list<Assignment>(
      `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`target/objectId eq '${context.id}'`)}&$expand=accessPackage&$select=id,state,schedule`,
      PACKAGE_SCOPE,
      signal,
    ),
    graph.list<Group>(
      `/users/${context.id}/transitiveMemberOf/microsoft.graph.group?$select=${GROUP_SELECT}&$count=true`,
      GROUP_SCOPE,
      signal,
    ),
    loadPim(context, graph, signal),
  ]);
  const user: DirectoryObject = { ...(profile ?? {}), id: context.id };
  const targeted = assignments.map((assignment) => ({
    ...assignment,
    target: { objectId: context.id },
  }));
  const now = Date.now();
  const eligibility = pim.filter(
    (instance) =>
      instance.status === 'eligible' &&
      instance.principalId.toLowerCase() === context.id.toLowerCase() &&
      isCurrentPimMember(instance, now),
  );
  return {
    title: `${user.displayName ?? user.userPrincipalName ?? user.id} - Groups`,
    rows: candidates(
      groups,
      transitive,
      eligibility.map((instance) => ({
        ...instance.group,
        id: instance.groupId,
      })),
    ).map(({ subject: group, membership }) => ({
      member: user,
      group,
      membership,
      eligibility: eligibility.filter(
        (instance) => instance.groupId.toLowerCase() === group.id.toLowerCase(),
      ),
      governance: classifyGovernance(group, context.id, packages, targeted, {
        membership,
        pim,
        now,
      }),
    })),
  };
}
