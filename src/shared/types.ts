export interface DirectoryObject {
  id: string;
  displayName?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
  '@odata.type'?: string;
}

export interface Group extends DirectoryObject {
  groupTypes?: string[];
  membershipRule?: string | null;
  onPremisesSyncEnabled?: boolean | null;
}

export interface AccessPackage {
  id: string;
  displayName: string;
  resourceRoleScopes?: {
    role?: { originId?: string; displayName?: string };
    scope?: { originId?: string; originSystem?: string; displayName?: string };
  }[];
  'resourceRoleScopes@odata.nextLink'?: string;
}

export interface Assignment {
  id: string;
  state: string;
  target?: { objectId?: string; displayName?: string };
  accessPackage?: {
    id: string;
    displayName?: string;
    catalog?: { displayName?: string };
  };
  assignmentPolicy?: { displayName?: string };
  schedule?: {
    startDateTime?: string;
    expiration?: {
      type?: string;
      endDateTime?: string | null;
      duration?: string | null;
    };
  };
}

export interface PackageResource {
  id: string;
  name: string;
  system: string;
}

export interface UserPackageAssignment extends Assignment {
  resources: PackageResource[];
}

export interface AssignmentRequest {
  id: string;
  state: string;
  createdDateTime?: string | null;
  accessPackage?: Assignment['accessPackage'] | null;
  assignment?: {
    id?: string;
    target?: { objectId?: string | null; displayName?: string | null } | null;
  } | null;
  requestor?: {
    displayName?: string | null;
    principalName?: string | null;
    email?: string | null;
    objectId?: string | null;
  } | null;
}

export interface UserAccessPackages {
  userId: string;
  displayName: string;
  assignments: UserPackageAssignment[];
  pendingRequests: AssignmentRequest[];
  pendingRequestsError?: string;
}

export interface DirectoryAudit {
  id: string;
  activityDisplayName?: string;
  activityDateTime?: string;
  result?: string;
  initiatedBy?: {
    user?: { userPrincipalName?: string | null; displayName?: string | null };
    app?: { displayName?: string | null; appId?: string | null };
  };
  targetResources?: {
    id?: string;
    modifiedProperties?: {
      displayName?: string;
      newValue?: string | null;
      oldValue?: string | null;
    }[];
  }[];
}
