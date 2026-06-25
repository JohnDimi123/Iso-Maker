/**
 * Logging subsystem.
 *
 * Logs are emitted as structured {@link LogEntry} records. Sinks can be
 * attached (console, rotating file, in-app console). The logger is process
 * wide but namespaced per source for readability.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LogEntry, LogLevel } from '../shared/types';
import { TypedEmitter } from './event-bus';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  success: 25,
  warn: 30,
  error: 40
};

export type LogSink = (entry: LogEntry) => void;

class Logger {
  private sinks: LogSink[] = [];
  private minLevel: LogLevel = 'debug';
  readonly events = new TypedEmitter<{ log: LogEntry }>();

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  addSink(sink: LogSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }

  /** Attach a file sink. The directory is created on demand. */
  addFileSink(filePath: string): () => void {
    mkdirSync(dirname(filePath), { recursive: true });
    const sink: LogSink = (entry) => {
      const line = `${new Date(entry.ts).toISOString()} [${entry.level.toUpperCase()}] (${entry.source}) ${entry.message}\n`;
      try {
        appendFileSync(filePath, line);
      } catch {
        /* best effort */
      }
    };
    return this.addSink(sink);
  }

  log(level: LogLevel, source: string, message: string): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = { ts: Date.now(), level, source, message };
    for (const sink of this.sinks) sink(entry);
    this.events.emit('log', entry);
  }

  child(source: string) {
    return {
      debug: (m: string) => this.log('debug', source, m),
      info: (m: string) => this.log('info', source, m),
      success: (m: string) => this.log('success', source, m),
      warn: (m: string) => this.log('warn', source, m),
      error: (m: string) => this.log('error', source, m)
    };
  }
}

export const logger = new Logger();

/** Convenience console sink with colour-free, parseable output. */
export const consoleSink: LogSink = (entry) => {
  const line = `[${entry.level}] (${entry.source}) ${entry.message}`;
  if (entry.level === 'error') console.error(line);
  else if (entry.level === 'warn') console.warn(line);
  else console.log(line);
};
