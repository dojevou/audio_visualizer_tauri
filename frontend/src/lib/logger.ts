import { trace, debug, info, warn, error, attachConsole } from '@tauri-apps/plugin-log';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

interface LogContext {
  [key: string]: unknown;
}

class Logger {
  private context: string;
  private initialized = false;

  constructor(context: string = 'App') {
    this.context = context;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      // Forward console.log/warn/error to the Rust backend
      await attachConsole();
      this.initialized = true;
    } catch (e) {
      // Fallback to console if not running in Tauri
      console.warn('Logger: Running outside Tauri, using console fallback');
    }
  }

  private formatMessage(message: string, ctx?: LogContext): string {
    const prefix = `[${this.context}]`;
    if (ctx && Object.keys(ctx).length > 0) {
      return `${prefix} ${message} ${JSON.stringify(ctx)}`;
    }
    return `${prefix} ${message}`;
  }

  trace(message: string, ctx?: LogContext): void {
    const formatted = this.formatMessage(message, ctx);
    trace(formatted).catch(() => console.debug(`[TRACE] ${formatted}`));
  }

  debug(message: string, ctx?: LogContext): void {
    const formatted = this.formatMessage(message, ctx);
    debug(formatted).catch(() => console.debug(formatted));
  }

  info(message: string, ctx?: LogContext): void {
    const formatted = this.formatMessage(message, ctx);
    info(formatted).catch(() => console.info(formatted));
  }

  warn(message: string, ctx?: LogContext): void {
    const formatted = this.formatMessage(message, ctx);
    warn(formatted).catch(() => console.warn(formatted));
  }

  error(message: string, ctx?: LogContext): void {
    const formatted = this.formatMessage(message, ctx);
    error(formatted).catch(() => console.error(formatted));
  }

  child(context: string): Logger {
    return new Logger(`${this.context}:${context}`);
  }

  timed<T>(label: string, fn: () => T): T {
    const start = performance.now();
    const result = fn();
    const duration = ((performance.now() - start) / 1000).toFixed(2);
    this.debug(`${label} completed`, { durationSec: duration });
    return result;
  }

  async timedAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const result = await fn();
    const duration = ((performance.now() - start) / 1000).toFixed(2);
    this.debug(`${label} completed`, { durationSec: duration });
    return result;
  }
}

// Default app logger
export const log = new Logger('App');

// Create child loggers for different modules
export const createLogger = (context: string): Logger => new Logger(context);

// Initialize on import
log.init();
