import type { GraphClient } from '../shared/graph';
import { ENTITLEMENTS, PACKAGE_SCOPE, loadPackages } from '../shared/packages';
import type {
  Assignment,
  PackageResource,
  UserAccessPackages,
} from '../shared/types';

export async function loadUserAccessPackages(
  userId: string,
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<UserAccessPackages> {
  const [packages, assignments] = await Promise.all([
    loadPackages(graph, sessionId, signal),
    graph.list<Assignment>(
      `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`target/objectId eq '${userId}'`)}&$expand=accessPackage($expand=catalog),assignmentPolicy,target`,
      PACKAGE_SCOPE,
      signal,
    ),
  ]);
  const byId = new Map(packages.map((pkg) => [pkg.id.toLowerCase(), pkg]));
  return {
    userId,
    displayName:
      assignments.find((assignment) => assignment.target?.displayName)?.target
        ?.displayName ?? userId,
    assignments: assignments.map((assignment) => {
      const pkg = byId.get(assignment.accessPackage?.id.toLowerCase() ?? '');
      const resources = new Map<string, PackageResource>();
      for (const { scope } of pkg?.resourceRoleScopes ?? []) {
        if (!scope?.originId || !scope.originSystem) continue;
        resources.set(`${scope.originSystem}:${scope.originId}`.toLowerCase(), {
          id: scope.originId,
          name: scope.displayName ?? scope.originId,
          system: scope.originSystem,
        });
      }
      return {
        ...assignment,
        resources: [...resources.values()],
      };
    }),
  };
}
