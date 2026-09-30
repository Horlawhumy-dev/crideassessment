import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'roles';
export type AllowedRole = 'RIDER' | 'DRIVER';

export const Roles = (...roles: AllowedRole[]) => SetMetadata(ROLES_KEY, roles);
