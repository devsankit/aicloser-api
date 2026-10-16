export function maskPhoneNumber(
  phone: string | null | undefined,
  shouldMask: boolean = false
): string | null {
  if (!phone) return null;
  if (!shouldMask) return phone;

  const trimmed = phone.trim();
  if (trimmed.length <= 4) return '****';

  if (trimmed.startsWith('+')) {
    const prefix = trimmed.slice(0, Math.max(5, trimmed.length - 5));
    return `${prefix}*****`;
  }

  const visible = trimmed.slice(0, Math.max(3, trimmed.length - 5));
  return `${visible}*****`;
}

export function isPhoneMaskingRequired(
  user?: { role?: string; permissions?: string[] } | null,
  workspaceSettings?: Record<string, any> | null
): boolean {
  if (!user) return false;
  if (user.role === 'ADMIN' || user.role === 'SUPER_ADMIN') return false;

  const security = workspaceSettings?.security || workspaceSettings;
  const maskingEnabled = Boolean(security?.maskCustomerPhone);

  if (!maskingEnabled) return false;

  if (Array.isArray(user.permissions) && user.permissions.includes('customer:unmask_phone')) {
    return false;
  }

  return user.role === 'SALES_AGENT';
}
