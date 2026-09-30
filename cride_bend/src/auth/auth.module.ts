import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { SocketAuth } from './socket-auth.gateway';
import { JwtStrategy } from './strategies/jwt.strategy';
import { SESSION_STORE } from './session.port';
import { PrismaSessionRepository } from './prisma-session.repository';
import { JwtAuthGuard } from '../common/guards/jwt.guard';
import { RolesGuard } from '../common/guards/roles.guard';

@Module({
  imports: [
    UsersModule,
    ConfigModule,
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<AppConfig>(APP_CONFIG)!.JWT_SECRET,
        // Pinned: verifying with a different algorithm than signing is how alg-confusion
        // (RS256/HS256, "alg: none") bypasses get in.
        signOptions: { algorithm: 'HS256' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    SocketAuth,
    JwtStrategy,
    PrismaSessionRepository,
    { provide: SESSION_STORE, useExisting: PrismaSessionRepository },
    JwtAuthGuard,
    RolesGuard,
  ],
  exports: [AuthService, TokenService, SocketAuth, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
