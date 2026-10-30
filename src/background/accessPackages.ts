import type { GraphClient } from '../shared/graph';
import { pendingRequestsForUser } from '../shared/accessPackages';
import { errorMessage } from '../shared/messages';
import { ENTITLEMENTS, PACKAGE_SCOPE, loadPackages } from '../shared/packages';
import type {
  Assignment,
  AssignmentRequest,
  PackageResource,
  UserAccessPackages,
} from '../shared/types';

export async function loadUserAccessPackages(
  userId: string,
  graph: GraphClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<UserAccessPackages> {
  const [packages, assignments, requestData] = await Promise.all([
    loadPackages(graph, sessionId, signal),
    graph.list<Assignment>(
      `${ENTITLEMENTS}/assignments?$filter=${encodeURIComponent(`target/objectId eq '${userId}'`)}&$expand=accessPackage($expand=catalog),assignmentPolicy,target`,
      PACKAGE_SCOPE,
      signal,
    ),
    graph
      .list<AssignmentRequest>(
        `${ENTITLEMENTS}/assignmentRequests?$filter=${encodeURIComponent("state eq 'pendingApproval'")}&$expand=accessPackage,assignment($expand=target),requestor`,
        PACKAGE_SCOPE,
        signal,
      )
      .then((requests) => ({
        pendingRequests: pendingRequestsForUser(requests, userId),
      }))
      .catch((error: unknown) => ({
        pendingRequests: [],
        pendingRequestsError: errorMessage(error),
      })),
  ]);
  const { pendingRequests } = requestData;
  const byId = new Map(packages.map((pkg) => [pkg.id.toLowerCase(), pkg]));
  return {
    userId,
    displayName:
      assignments.find((assignment) => assignment.target?.displayName)?.target
        ?.displayName ??
      pendingRequests.find((request) => request.assignment?.target?.displayName)
        ?.assignment?.target?.displayName ??
      userId,
    ...requestData,
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
