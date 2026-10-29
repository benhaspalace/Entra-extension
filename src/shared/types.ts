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
    scope?: { originId?: string; originSystem?: string };
  }[];
}

export interface Assignment {
  id: string;
  state: string;
  target?: { objectId?: string };
  accessPackage?: { id: string; displayName?: string };
  schedule?: {
    startDateTime?: string;
    expiration?: {
      type?: string;
      endDateTime?: string | null;
      duration?: string | null;
    };
  };
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
