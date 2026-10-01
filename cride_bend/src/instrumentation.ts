/** MUST be the first import in main.ts and worker.ts, before anything that pulls in an
 * instrumented library: the auto-instrumentation packages patch module loaders, so importing
 * them later registers hooks too late to observe startup. */
import { config } from 'dotenv';

async function bootstrapTelemetry(): Promise<void> {
  config();

  if (process.env.OTEL_ENABLED !== 'true') return;

  const { NodeSDK } = await import('@opentelemetry/sdk-node');
  const { getNodeAutoInstrumentations } = await import(
    '@opentelemetry/auto-instrumentations-node'
  );
  const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');

  const sdk = new NodeSDK({
    serviceName: `cride-${process.env.APP_ROLE ?? 'all'}`,
    traceExporter: new OTLPTraceExporter({
      url: `${process.env.OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // An instrumented HTTP client that logs full request bodies is how passwords
        // and coordinates end up in a tracing backend.
        '@opentelemetry/instrumentation-fs': { enabled: false },
      }),
    ],
  });

  sdk.start();
  process.on('SIGTERM', () => void sdk.shutdown());
}

void bootstrapTelemetry();
