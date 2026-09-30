import { Body, Controller, Get, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { CookieOptions, Response } from 'express';
import { Public } from '../common/decorators/public.decorator';
import { DomainError } from '../common/errors/domain-error';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  loginSchema,
  refreshSchema,
  registerSchema,
  type LoginDto,
  type RefreshDto,
  type RegisterDto,
} from './dto/auth.dto';
import { AuthService, type AuthResult } from './auth.service';
import type { Principal } from './principal';
import { zodToOpenApiComponent } from '../common/openapi/zod-to-openapi';
import { AuthSessionResponseDto, PrincipalDto } from '../common/openapi/api-schemas';
import {
  ApiAuthedErrorResponses,
  ApiErrorResponses,
  ApiRefreshCookieErrorResponses,
} from '../common/openapi/api-error-responses';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../common/openapi/cookie-names';

// The access token is returned in the body *and* set httpOnly: the BFF and the socket
// handshake need it in JS, httpOnly keeps XSS out. The refresh token is cookie-only —
// a body copy would let any XSS escalate a 15-minute token into a permanent session.
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    operationId: 'register',
    summary: 'Create an account and start a session',
    description: [
      'Sets the `cride.sid` and `cride.refresh` cookies and returns the access token in the body.',
      '',
      'A duplicate email returns `INVALID_CREDENTIALS` (401), not a distinct "already registered"',
      'code: telling a caller that an address is taken is the same enumeration oracle the login path',
      'is built to avoid.',
      '',
      'Anyone may register as `DRIVER`; nearest-driver matching is deliberately deferred (§9.1), so',
      'there is no approval step yet.',
    ].join('\n'),
  })
  @ApiBody({
    schema: zodToOpenApiComponent(registerSchema, 'RegisterRequest'),
    examples: {
      rider: {
        summary: 'Rider',
        value: { email: 'ada@example.com', password: 'correct-horse-battery', displayName: 'Ada', role: 'RIDER' },
      },
      driver: {
        summary: 'Driver',
        value: {
          email: 'grace@example.com',
          password: 'correct-horse-battery',
          displayName: 'Grace',
          role: 'DRIVER',
          phone: '+15551234567',
        },
      },
    },
  })
  @ApiOkResponse({ type: AuthSessionResponseDto, description: 'Account created; session started.' })
  @ApiErrorResponses('MISSING_FIELD')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) dto: RegisterDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(await this.auth.register(dto), res);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  // 5/min vs the 120/min global default: credential-stuffing control, so per-route.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    operationId: 'login',
    summary: 'Exchange credentials for a session',
    description: [
      'Sets the `cride.sid` and `cride.refresh` cookies and returns the access token in the body.',
      '',
      'Non-enumerable by construction: a wrong password and an unknown address produce the same',
      'code, the same status and comparable work, including a dummy bcrypt comparison on the',
      'unknown-address path so the two are not distinguishable by timing.',
    ].join('\n'),
  })
  @ApiBody({
    schema: zodToOpenApiComponent(loginSchema, 'LoginRequest'),
    examples: {
      default: { summary: 'Credentials', value: { email: 'ada@example.com', password: 'correct-horse-battery' } },
    },
  })
  @ApiOkResponse({ type: AuthSessionResponseDto, description: 'Session started.' })
  @ApiErrorResponses('MISSING_FIELD', 'INVALID_CREDENTIALS')
  async login(
    @Body(new ZodValidationPipe(loginSchema)) dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(await this.auth.login(dto), res);
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: 'refreshSession',
    summary: 'Rotate the access token',
    description: [
      'The refresh token is read from the `cride.refresh` cookie. Presenting an already-consumed',
      'token revokes the whole session family.',
      '',
      'Rotation is what makes theft detectable: each refresh issues a new token and marks the old',
      'one used, so an attacker replaying a stolen token and a legitimate client racing each other',
      'both land on the same signal — the family is burned and both are logged out.',
      '',
      'A body `refreshToken` is accepted as a fallback for non-browser clients (a seed script, a',
      'test). The route is public because the access token is typically already expired when this',
      'is called.',
    ].join('\n'),
  })
  @ApiBody({
    schema: zodToOpenApiComponent(refreshSchema, 'RefreshRequest'),
    required: false,
    description: 'Optional body override. The cookie takes precedence when both are present.',
  })
  @ApiOkResponse({ type: AuthSessionResponseDto, description: 'New access and refresh tokens issued.' })
  @ApiRefreshCookieErrorResponses('MISSING_FIELD')
  async refresh(
    @Body(new ZodValidationPipe(refreshSchema)) dto: RefreshDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Cookie first: the body is only a fallback for non-browser clients (the seed
    // script, a test).
    const token = res.req?.cookies?.[REFRESH_COOKIE] ?? dto.refreshToken;

    // Not checked in refreshSchema: Zod cannot read the cookie, and requiring the
    // body would make the cookie path — the primary one — unreachable.
    if (!token) {
      throw new DomainError(
        'MISSING_FIELD',
        'A refresh token is required, as the cride.refresh cookie or in the body.',
        { field: 'refreshToken' },
      );
    }

    return this.respond(await this.auth.refresh(token), res);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    operationId: 'logout',
    summary: 'Revoke every refresh token for the current user',
    description: [
      'Revokes the whole refresh-token family, not just the presented token, so a token copied',
      'before logout is also dead. Clears both cookies. Returns 204 with no body.',
    ].join('\n'),
  })
  @ApiNoContentResponse({ description: 'Session revoked and cookies cleared.' })
  @ApiAuthedErrorResponses()
  async logout(@CurrentUser() principal: Principal, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(principal.userId);
    res.clearCookie(ACCESS_COOKIE, cookieBase());
    res.clearCookie(REFRESH_COOKIE, cookieBase());
  }

  @Get('me')
  @ApiOperation({
    operationId: 'getPrincipal',
    summary: 'The current session and account',
    description: [
      'The identity carried by the access token, plus the account behind it.',
      '',
      'The three identity fields come from the token. The `user` object is loaded server-side on',
      'each call rather than read out of the token, because a JWT is base64 rather than encrypted:',
      'a display name inside it would be readable by anyone holding the token. A UI has to be able to',
      'greet someone by name after a reload, so the profile is resolved here instead.',
      '',
      'This is the one route a client calls to bootstrap itself, so it is the natural place for the',
      'client to learn which role-specific surface it should render.',
    ].join('\n'),
  })
  @ApiOkResponse({ type: PrincipalDto, description: 'Identity decoded from the access token, with its account.' })
  @ApiAuthedErrorResponses('USER_NOT_FOUND')
  async me(@CurrentUser() principal: Principal) {
    return { ...principal, user: await this.auth.currentUser(principal) };
  }

  private respond(result: AuthResult, res: Response) {
    const secure = process.env.NODE_ENV === 'production';

    res.cookie(ACCESS_COOKIE, result.accessToken, {
      ...cookieBase(),
      secure,
      maxAge: result.expiresIn * 1000,
    });

    res.cookie(REFRESH_COOKIE, result.refreshToken, {
      ...cookieBase(),
      secure,
      // 30 d, deliberately shorter than the token TTL: a session unused that long must re-login.
      maxAge: 30 * 86_400_000,
    });

    return { user: result.user, accessToken: result.accessToken, expiresIn: result.expiresIn };
  }
}

function cookieBase(): CookieOptions {
  // 'lax' not 'strict': strict drops the cookie on a top-level navigation from an external link.
  return { httpOnly: true, sameSite: 'lax', path: '/' };
}
