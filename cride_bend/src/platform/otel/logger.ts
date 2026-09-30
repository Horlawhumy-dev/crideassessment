import { Injectable, LoggerService as NestLoggerService } from '@nestjs/common';

type Level = 'debug' | 'info' | 'warn' | 'error';

/** One JSON object per line — never an interpolated string, because logs that are not
 * parseable cannot be joined to traces. */
@Injectable()
export class LoggerService implements NestLoggerService {
  private readonly minLevel: Level = (process.env.LOG_LEVEL as Level) ?? 'info';
  private readonly order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

  private write(level: Level, message: string, fields?: Record<string, unknown>): void {
    if (this.order[level] < this.order[this.minLevel]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      message,
      ...fields,
    });
    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  }

  debug(m: string, f?: Record<string, unknown>): void { this.write('debug', m, f); }
  log(m: string, f?: Record<string, unknown>): void { this.write('info', m, f); }
  info(m: string, f?: Record<string, unknown>): void { this.write('info', m, f); }
  warn(m: string, f?: Record<string, unknown>): void { this.write('warn', m, f); }
  error(m: string, f?: Record<string, unknown>): void { this.write('error', m, f); }

  verbose(m: string): void { this.write('debug', m); }
  fatal(m: string, f?: Record<string, unknown>): void { this.write('error', m, f); }
}
