import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { AuthError, UserNotFoundError } from '../common/errors/domain-error';
import { USERS_REPOSITORY, type UserRecord, type UsersRepository } from '../users/users.repository';
import { TokenService } from './token.service';
import type { Principal } from './principal';
import {
  REFRESH_TOKEN_TTL_DAYS,
  newFamilyId,
  newRefreshToken,
  SESSION_STORE,
  type SessionStore,
} from './session.port';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

export interface AuthUserView {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: 'RIDER' | 'DRIVER';
}

export interface AuthResult {
  readonly user: AuthUserView;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresIn: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(USERS_REPOSITORY) private readonly users: UsersRepository,
    @Inject(SESSION_STORE) private readonly sessions: SessionStore,
    private readonly tokens: TokenService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<AuthResult> {
    // INVALID_CREDENTIALS, not a distinct code: "email already taken" is the
    // enumeration oracle the login path exists to avoid.
    if (await this.users.existsByEmail(dto.email)) {
      throw new AuthError('INVALID_CREDENTIALS');
    }

    const { BCRYPT_ROUNDS } = this.config.get<AppConfig>(APP_CONFIG)!;
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    const user = await this.users.create({
      email: dto.email,
      passwordHash,
      displayName: dto.displayName,
      role: dto.role,
      phone: dto.phone,
    });

    return this.startSession(user);
  }

  async login(dto: LoginDto): Promise<AuthResult> {
    const found = await this.users.findByEmail(dto.email);

    if (!found) {
      // Dummy compare so a missing account is not distinguishable by latency.
      await bcrypt.compare(dto.password, DUMMY_HASH);
      throw new AuthError('INVALID_CREDENTIALS');
    }

    const ok = await bcrypt.compare(dto.password, found.passwordHash);
    if (!ok) throw new AuthError('INVALID_CREDENTIALS');

    return this.startSession(found);
  }

  async refresh(refreshToken: string): Promise<AuthResult> {
    const consumed = await this.sessions.consume(refreshToken);

    if (consumed === 'REPLAYED') {
      // The only branch worth alerting on: a token that was valid came back
      // twice, so two parties hold credentials from one family.
      this.logger.warn('auth.refresh_replay_detected');
      throw new AuthError('TOKEN_REVOKED');
    }

    // A distinct code from TOKEN_REVOKED so a stale cookie cannot masquerade as a theft alert.
    if (!consumed) throw new AuthError('INVALID_REFRESH_TOKEN');

    const user = await this.users.findById(consumed.userId);
    // Token row whose user was deleted: same class as unrecognised, nothing to steal.
    if (!user) throw new AuthError('INVALID_REFRESH_TOKEN');

    // Same familyId, so a later replay still revokes everything issued from this login.
    return this.startSession(user, consumed.familyId);
  }

  async logout(userId: string): Promise<void> {
    await this.sessions.revokeSessionUserTokens(userId);
  }

  /**
   * The token carries only id, role and sid: a JWT is base64, not encrypted, so any
   * field in it is readable by the client. The profile is loaded per request here
   * rather than cached in the token.
   */
  async currentUser(principal: Principal): Promise<AuthResult['user'] & { phone: string | null; isAvailable: boolean }> {
    const user = await this.users.findById(principal.userId);
    // Verified signature for a deleted row: the session is real, the account is gone.
    if (!user) throw new UserNotFoundError(principal.userId);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      phone: user.phone,
      isAvailable: user.isAvailable,
    };
  }

  private async startSession(user: UserRecord, existingFamilyId?: string): Promise<AuthResult> {
    const sessionId = randomUUID();
    const { token, claims } = this.tokens.signAccessToken({
      sub: user.id,
      role: user.role,
      sid: sessionId,
    });

    const refreshToken = newRefreshToken();
    await this.sessions.issue({
      userId: user.id,
      familyId: existingFamilyId ?? newFamilyId(),
      token: refreshToken,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    });

    const view: AuthUserView = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    };

    return {
      user: view,
      accessToken: token,
      refreshToken,
      expiresIn: claims.exp - claims.iat,
    };
  }
}

/**
 * A real bcrypt hash: any non-bcrypt string would fail fast inside bcrypt.compare
 * and reopen the timing gap the dummy compare exists to close.
 */
const DUMMY_HASH = '$2b$12$KbQi1xN6HnTuS8uQOWAqzO1w4tC2K9R3F2AaDkMHQ1C7NvQfEhz8Iq';
