import type { Assignment, AssignmentRequest } from './types';
import { isActiveAssignment } from './governance';

export function groupAssignments<T extends Assignment>(
  assignments: readonly T[],
): { active: T[]; inactive: T[] } {
  const active: T[] = [];
  const inactive: T[] = [];
  for (const assignment of assignments) {
    (isActiveAssignment(assignment.state) ? active : inactive).push(assignment);
  }
  return { active, inactive };
}

export function pendingRequestsForUser(
  requests: readonly AssignmentRequest[],
  userId: string,
): AssignmentRequest[] {
  return requests.filter((request) => {
    if (request.state !== 'pendingApproval') return false;
    const recipientId = request.assignment?.target?.objectId;
    if (!recipientId)
      throw new Error(
        'Microsoft Graph omitted a pending request recipient; pending requests could not be determined.',
      );
    return recipientId.toLowerCase() === userId.toLowerCase();
  });
}

export function formatRequestor(
  requestor: AssignmentRequest['requestor'],
): string {
  return (
    requestor?.displayName ||
    requestor?.principalName ||
    requestor?.email ||
    requestor?.objectId ||
    'Not provided'
  );
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return 'Not provided';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Invalid date' : date.toISOString();
}

export function formatExpiration(schedule: Assignment['schedule']): string {
  const expiration = schedule?.expiration;
  if (expiration?.type === 'noExpiration') return 'No expiration';
  if (expiration?.endDateTime) return formatDate(expiration.endDateTime);
  if (expiration?.duration)
    return `After ${expiration.duration} from ${formatDate(schedule?.startDateTime)}`;
  return 'Not provided';
}
