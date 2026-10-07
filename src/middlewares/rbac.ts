import { Request, Response, NextFunction } from 'express';
import { UserRole } from '../types/auth.js';

export function requireRoles(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    if (!allowedRoles.includes(user.role)) {
      res.status(403).json({
        success: false,
        error: 'Forbidden',
        message: `Insufficient permissions: role ${user.role} is not authorized for this resource`,
      });
      return;
    }

    next();
  };
}
