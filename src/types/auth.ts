export type UserRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'SALES_AGENT' | 'FREELANCER' | 'CLIENT';

export interface AuthenticatedUser {
  userId: string;
  role: UserRole;
  tenantId: string | null;
  displayName: string;
  phone: string;
  email?: string | null;
  sessionId?: string;
  clientType?: 'MOBILE' | 'DESKTOP';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      tenantId?: string;
      isSuperAdminOverride?: boolean;
      requestId?: string;
    }
  }
}
