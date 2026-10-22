import { prisma } from './prisma.js';

type ScopeUser = {
  userId: string;
  role: string;
};

export type WorkspaceScope = {
  all: boolean;
  profileIds: string[];
  userIds: string[];
};

/**
 * Resolve the records a workspace user may operate on.
 *
 * Admins intentionally receive the tenant-wide scope. Managers receive their
 * own profile plus every descendant in the reporting tree. Closers receive
 * only their own profile. The scope is computed from the canonical profile
 * hierarchy, never from UI-provided agent IDs.
 */
export async function getWorkspaceScope(tenantId: string, user: ScopeUser): Promise<WorkspaceScope> {
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') {
    return { all: true, profileIds: [], userIds: [] };
  }

  const profiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: { not: 'SUSPENDED' },
    },
    select: { id: true, userId: true, parentAgentId: true },
  });

  const current = profiles.find((profile) => profile.userId === user.userId);
  if (!current) return { all: false, profileIds: [], userIds: [] };

  if (user.role !== 'MANAGER') {
    return { all: false, profileIds: [current.id], userIds: [current.userId] };
  }

  const children = new Map<string, string[]>();
  for (const profile of profiles) {
    if (!profile.parentAgentId) continue;
    const branch = children.get(profile.parentAgentId) || [];
    branch.push(profile.id);
    children.set(profile.parentAgentId, branch);
  }

  const visibleProfileIds = new Set<string>([current.id]);
  const pending = [current.id];
  while (pending.length) {
    const parentId = pending.shift()!;
    for (const childId of children.get(parentId) || []) {
      if (visibleProfileIds.has(childId)) continue;
      visibleProfileIds.add(childId);
      pending.push(childId);
    }
  }

  const visibleProfiles = profiles.filter((profile) => visibleProfileIds.has(profile.id));
  return {
    all: false,
    profileIds: visibleProfiles.map((profile) => profile.id),
    userIds: visibleProfiles.map((profile) => profile.userId),
  };
}

/**
 * Check if two users/agents belong to the same reporting team or hierarchy branch.
 * Same reporting team condition:
 * - Same user or same profile
 * - Same group (groupId matches)
 * - Same direct parent/manager (parentAgentId matches)
 * - One is the direct or ancestor manager/parent of the other
 */
export async function checkSameReportingTeam(
  tenantId: string,
  requesterUserIdOrProfileId: string,
  targetUserIdOrProfileId: string
): Promise<boolean> {
  if (!requesterUserIdOrProfileId || !targetUserIdOrProfileId) return false;
  if (requesterUserIdOrProfileId === targetUserIdOrProfileId) return true;

  const profiles = await prisma.salesAgentProfile.findMany({
    where: {
      tenantId,
      status: { not: 'SUSPENDED' },
    },
    select: {
      id: true,
      userId: true,
      parentAgentId: true,
      groupId: true,
      user: { select: { role: true } },
    },
  });

  const requester = profiles.find(
    (p) => p.userId === requesterUserIdOrProfileId || p.id === requesterUserIdOrProfileId
  );
  const target = profiles.find(
    (p) => p.userId === targetUserIdOrProfileId || p.id === targetUserIdOrProfileId
  );

  if (!requester || !target) return false;
  if (requester.id === target.id) return true;

  // Leadership (Admins and Managers) can always participate in conversation sharing
  const targetRole = String(target.user?.role || '').toUpperCase();
  if (targetRole === 'ADMIN' || targetRole === 'SUPER_ADMIN' || targetRole === 'MANAGER') {
    return true;
  }
  const requesterRole = String(requester.user?.role || '').toUpperCase();
  if (requesterRole === 'ADMIN' || requesterRole === 'SUPER_ADMIN' || requesterRole === 'MANAGER') {
    return true;
  }

  // 1. Same group
  if (requester.groupId && target.groupId && requester.groupId === target.groupId) {
    return true;
  }

  // 2. Same parent agent / manager
  if (requester.parentAgentId && target.parentAgentId && requester.parentAgentId === target.parentAgentId) {
    return true;
  }

  // 3. Direct manager-subordinate relationship
  if (requester.id === target.parentAgentId || target.id === requester.parentAgentId) {
    return true;
  }

  // 4. Default unassigned flat hierarchy fallback: if neither agent has a designated manager, they are peer closers in the same workspace
  if (!requester.parentAgentId && !target.parentAgentId) {
    return true;
  }

  // 4. Ancestor/descendant relationship in tree
  const isDescendant = (ancestorId: string, childId: string): boolean => {
    let curr = profiles.find((p) => p.id === childId);
    const visited = new Set<string>();
    while (curr && curr.parentAgentId && !visited.has(curr.parentAgentId)) {
      visited.add(curr.parentAgentId);
      if (curr.parentAgentId === ancestorId) return true;
      curr = profiles.find((p) => p.id === curr!.parentAgentId);
    }
    return false;
  };

  if (isDescendant(requester.id, target.id) || isDescendant(target.id, requester.id)) {
    return true;
  }

  return false;
}

