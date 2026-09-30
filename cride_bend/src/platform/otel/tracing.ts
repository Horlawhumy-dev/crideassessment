import { Injectable } from '@nestjs/common';
import { context, trace, SpanStatusCode, type Span } from '@opentelemetry/api';

const tracer = trace.getTracer('cride');

/** Instrumentation is in src/instrumentation.ts, which must be imported before anything
 * else — the auto-instrumentation patches loaders, so importing it later registers hooks
 * too late to observe startup. */
@Injectable()
export class TracingService {
  /** Motivating span: "why did accepting this ride take 1.8s?" */
  async span<T>(name: string, attributes: Record<string, string | number | boolean>, fn: (span: Span) => Promise<T>): Promise<T> {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  currentCorrelationId(): string | undefined {
    const span = trace.getSpan(context.active());
    const sc = span?.spanContext();
    return sc?.traceId;
  }
}
