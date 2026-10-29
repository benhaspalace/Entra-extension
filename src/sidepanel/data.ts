import type { EntraContext } from '../shared/context';
import {
  classifyGovernance,
  packageContainsGroup,
  type Governance,
} from '../shared/governance';
import type { GraphClient } from '../shared/graph';
import type {
  AccessPackage,
  Assignment,
  DirectoryObject,
  Group,
} from '../shared/types';

const ENTITLEMENTS = '/identityGovernance/entitlementManagement';
const GROUP_SELECT =
  'id,displayName,groupTypes,membershipRule,onPremisesSyncEnabled';
const PACKAGE_SCOPE = 'EntitlementManagement.Read.All';
const GROUP_SCOPE = 'GroupMember.Read.All';

export interface MembershipRow {
  member: DirectoryObject;
  group: Group;
  governance: Governance;
}

export interface MembershipData {
  title: string;
  rows: MembershipRow[];
}

interface PackageCache {
  sessionId: string;
  expiresAt: number;
  packages: AccessPackage[];
}

async function loadPackages(
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<AccessPackage[]> {
  const stored = await chrome.storage.session.get('packageCache');
  const cache = stored.packageCache as PackageCache | undefined;
  if (cache?.sessionId === sessionId && cache.expiresAt > Date.now())
    return cache.packages;

  // Expanded relationship collections can themselves be paged. Fetch each
  // package's role scopes as a list so no nested continuation is overlooked.
  const packages = await graph.list<AccessPackage>(
    `${ENTITLEMENTS}/accessPackages?$select=id,displayName`,
    PACKAGE_SCOPE,
    signal,
  );
  const complete = await mapLimited(packages, 4, async (pkg) => ({
    ...pkg,
    resourceRoleScopes: await graph.list<
      NonNullable<AccessPackage['resourceRoleScopes']>[number]
    >(
      `${ENTITLEMENTS}/accessPackages/${encodeURIComponent(pkg.id)}/resourceRoleScopes?$expand=scope`,
      PACKAGE_SCOPE,
      signal,
    ),
  }));
  signal.throwIfAborted();
  const auth = await chrome.storage.session.get('auth');
  const current = auth.auth as { sessionId?: string } | undefined;
  if (current?.sessionId === sessionId)
    await chrome.storage.session.set({
      packageCache: {
        sessionId,
        expiresAt: Date.now() + 15 * 60_000,
        packages: complete,
      } satisfies PackageCache,
    });
  return complete;
}

export async function mapLimited<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error('Concurrency must be a positive integer.');
  const results: R[] = new Array(items.length);
  const pending = items.entries();
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (const [index, item] of pending) {
        results[index] = await operation(item);
      }
    }),
  );
  return results;
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
          `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`accessPackage/id eq '${pkg.id}' and state eq 'delivered'`)}&$expand=target&$select=id,state,schedule`,
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
  const user: DirectoryObject = { id: context.id };
  const [groups, assignments] = await Promise.all([
    graph.list<Group>(
      `/users/${context.id}/memberOf/microsoft.graph.group?$select=${GROUP_SELECT}&$count=true`,
      GROUP_SCOPE,
      signal,
    ),
    graph.list<Assignment>(
      `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`target/objectId eq '${context.id}' and state eq 'delivered'`)}&$expand=accessPackage&$select=id,state,schedule`,
      PACKAGE_SCOPE,
      signal,
    ),
  ]);
  const targeted = assignments.map((assignment) => ({
    ...assignment,
    target: { objectId: context.id },
  }));
  return {
    title: `${user.displayName ?? user.id} - Groups`,
    rows: groups.map((group) => ({
      member: user,
      group,
      governance: classifyGovernance(group, context.id, packages, targeted),
    })),
  };
}
