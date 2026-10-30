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
        `${ENTITLEMENTS}/assignmentRequests?$filter=${encodeURIComponent("state eq 'pendingApproval'")}&$expand=accessPackage,assignment,requestor`,
        PACKAGE_SCOPE,
        signal,
      )
      .then(async (requests) => {
        const targets = new Map<string, Assignment['target']>();
        const resolved: AssignmentRequest[] = [];
        for (const request of requests) {
          if (request.state !== 'pendingApproval') continue;
          if (request.assignment?.target?.objectId) {
            resolved.push(request);
            continue;
          }
          const assignmentId = request.assignment?.id;
          if (!assignmentId)
            throw new Error(
              'Microsoft Graph omitted a pending request assignment ID; its recipient could not be resolved.',
            );
          if (!targets.has(assignmentId)) {
            const assignment = await graph.graphFetch<Assignment>(
              `${ENTITLEMENTS}/assignments/${encodeURIComponent(assignmentId)}?$expand=target`,
              PACKAGE_SCOPE,
              signal,
            );
            targets.set(assignmentId, assignment.target);
          }
          resolved.push({
            ...request,
            assignment: {
              ...request.assignment,
              target: targets.get(assignmentId) ?? null,
            },
          });
        }
        return { pendingRequests: pendingRequestsForUser(resolved, userId) };
      })
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
