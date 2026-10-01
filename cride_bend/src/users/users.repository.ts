/** The application-layer port; it carries no Prisma types. */
export interface UserRecord {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'RIDER' | 'DRIVER';
  readonly phone: string | null;
  readonly isAvailable: boolean;
  readonly fcmEnabled: boolean;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly displayName: string;
  readonly role: 'RIDER' | 'DRIVER';
  readonly phone?: string;
}

export const USERS_REPOSITORY = Symbol('USERS_REPOSITORY');

export interface UsersRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<(UserRecord & { passwordHash: string }) | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  existsByEmail(email: string): Promise<boolean>;
  /** Driver presence; null when the id is unknown. */
  setAvailability(id: string, isAvailable: boolean): Promise<UserRecord | null>;
}
