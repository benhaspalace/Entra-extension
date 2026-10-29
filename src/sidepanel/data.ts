import type { EntraContext } from '../shared/context';
import {
  classifyGovernance,
  packageContainsGroup,
  type Governance,
} from '../shared/governance';
import type { GraphClient } from '../shared/graph';
import {
  ENTITLEMENTS,
  PACKAGE_SCOPE,
  loadPackages,
  mapLimited,
} from '../shared/packages';
import type { Assignment, DirectoryObject, Group } from '../shared/types';

const GROUP_SELECT =
  'id,displayName,groupTypes,membershipRule,onPremisesSyncEnabled';
const GROUP_SCOPE = 'GroupMember.Read.All';
// Graph documents only `eq` on state, so active states are filtered client-side
// by classifyGovernance rather than with an `or` filter.

export interface MembershipRow {
  member: DirectoryObject;
  group: Group;
  governance: Governance;
}

export interface MembershipData {
  title: string;
  rows: MembershipRow[];
}

export async function loadMembership(
  context: EntraContext,
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<MembershipData> {
  const packages = await loadPackages(graph, sessionId, signal);
  if (context.kind === 'group') {
    const [group, members] = await Promise.all([
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
    return {
      title: `${group.displayName ?? group.id} - Members`,
      rows: members.map((member) => ({
        member,
        group,
        governance: classifyGovernance(group, member.id, packages, assignments),
      })),
    };
  }
  const [profile, groups, assignments] = await Promise.all([
    graph.graphFetch<DirectoryObject>(
      `/users/${context.id}?$select=displayName,userPrincipalName`,
      GROUP_SCOPE,
      signal,
    ),
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
  ]);
  const user: DirectoryObject = { ...profile, id: context.id };
  const targeted = assignments.map((assignment) => ({
    ...assignment,
    target: { objectId: context.id },
  }));
  return {
    title: `${user.displayName ?? user.userPrincipalName ?? user.id} - Groups`,
    rows: groups.map((group) => ({
      member: user,
      group,
      governance: classifyGovernance(group, context.id, packages, targeted),
    })),
  };
}
