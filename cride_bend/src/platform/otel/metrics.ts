import { Injectable } from '@nestjs/common';

export interface Counter { inc(labels?: Record<string, string | number>): void }
export interface Histogram { observe(value: number, labels?: Record<string, string | number>): void }
export interface Gauge { set(value: number, labels?: Record<string, string | number>): void }

function noop(): void {}

/** In-process registry behind an interface, so call sites do not change when an OTLP
 * exporter lands. `outbox_lag_seconds` is the health metric for delivery. */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, number[]>();
  private readonly gauges = new Map<string, Map<string, number>>();

  counter(name: string): Counter {
    return {
      inc: (labels = {}) => this.increment(name, labels),
    };
  }

  histogram(name: string): Histogram {
    return {
      observe: (value: number) => {
        const list = this.histograms.get(name) ?? [];
        list.push(value);
        this.histograms.set(name, list);
      },
    };
  }

  gauge(name: string): Gauge {
    return {
      set: (value: number, labels = {}) => {
        const key = `${name}${serialiseLabels(labels)}`;
        const bucket = this.gauges.get(name) ?? new Map<string, number>();
        bucket.set(key, value);
        this.gauges.set(name, bucket);
      },
    };
  }

  /** Test and diagnostics hook. */
  snapshot(): Record<string, unknown> {
    return {
      counters: Object.fromEntries(
        [...this.counters].map(([name, labels]) => [
          name,
          Object.fromEntries(labels),
        ]),
      ),
      gauges: Object.fromEntries([...this.gauges].map(([n, m]) => [n, Object.fromEntries(m)])),
      histograms: Object.fromEntries(
        [...this.histograms].map(([n, values]) => [
          n,
          { count: values.length, avg: values.reduce((a, b) => a + b, 0) / (values.length || 1) },
        ]),
      ),
    };
  }

  reset(): void {
    this.counters.clear();
    this.histograms.clear();
    this.gauges.clear();
  }

  private increment(name: string, labels: Record<string, string | number>): void {
    const bucket = this.counters.get(name) ?? new Map<string, number>();
    const key = serialiseLabels(labels);
    bucket.set(key, (bucket.get(key) ?? 0) + 1);
    this.counters.set(name, bucket);
  }
}

function serialiseLabels(labels: Record<string, string | number>): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(',');
}

export { noop };
