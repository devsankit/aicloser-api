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
