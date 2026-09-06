import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { isAbsolute, resolve } from 'node:path';
import { canonicalJson, EngineError, errorCode } from './util.mjs';
import { decodeStrictUtf8, parseStrictJson } from './strict-json.mjs';
import { withPinnedExecutable } from './executable-pin.mjs';

const SAFE_ENVIRONMENT_NAMES = new Set([
  'PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'
]);
const SECRET_ENVIRONMENT_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|AUTH|CREDENTIAL|COOKIE|SESSION)/i;

export function buildAllowedEnvironment(source, allowlist) {
  if (source === null || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(allowlist)) throw new EngineError('PROVIDER_ENVIRONMENT_INVALID');
  const output = Object.create(null);
  for (const name of allowlist) {
    if (!SAFE_ENVIRONMENT_NAMES.has(name) || SECRET_ENVIRONMENT_PATTERN.test(name)) throw new EngineError('PROVIDER_ENVIRONMENT_NAME_FORBIDDEN');
    const value = source[name];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.includes('\0') || value.includes('\r') || value.includes('\n') || Buffer.byteLength(value, 'utf8') > 32768) throw new EngineError('PROVIDER_ENVIRONMENT_VALUE_INVALID');
    output[name] = value;
  }
  return Object.freeze(output);
}

export class BoundedNdjsonFramer {
  constructor(options = {}) {
    this.maximumLineBytes = options.maximumLineBytes ?? 1048576;
    this.maximumTotalBytes = options.maximumTotalBytes ?? 8388608;
    this.maximumLines = options.maximumLines ?? 10000;
    this.pending = Buffer.alloc(0);
    this.totalBytes = 0;
    this.lineCount = 0;
  }

  push(chunkValue) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.maximumTotalBytes) throw new EngineError('PROVIDER_STDOUT_TOTAL_OVERSIZE');
    this.pending = Buffer.concat([this.pending, chunk]);
    const messages = [];
    while (true) {
      const newline = this.pending.indexOf(0x0a);
      if (newline < 0) break;
      const line = this.pending.subarray(0, newline);
      this.pending = this.pending.subarray(newline + 1);
      this.lineCount += 1;
      if (this.lineCount > this.maximumLines) throw new EngineError('PROVIDER_STDOUT_LINE_COUNT_EXCEEDED');
      const text = decodeStrictUtf8(line, this.maximumLineBytes);
      messages.push(parseStrictJson(text, { maximumBytes: this.maximumLineBytes, maximumNodes: 32768, maximumDepth: 64, maximumNumberDigits: 32 }));
    }
    if (this.pending.length > this.maximumLineBytes) throw new EngineError('PROVIDER_STDOUT_LINE_OVERSIZE');
    return messages;
  }

  finish() {
    if (this.pending.length !== 0) throw new EngineError('PROVIDER_STDOUT_TRUNCATED_LINE');
    return Object.freeze({ total_bytes: this.totalBytes, line_count: this.lineCount });
  }
}

class BoundedStderrDigest {
  constructor(maximumBytes) {
    this.maximumBytes = maximumBytes;
    this.bytes = 0;
    this.hash = createHash('sha256');
  }
  push(chunkValue) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    this.bytes += chunk.length;
    if (this.bytes > this.maximumBytes) throw new EngineError('PROVIDER_STDERR_TOTAL_OVERSIZE');
    this.hash.update(chunk);
  }
  finish() { return Object.freeze({ bytes: this.bytes, sha256: this.hash.digest('hex') }); }
}

function validateLifecycle(options) {
  if (!['PERSISTENT', 'ONESHOT'].includes(options.mode)) throw new EngineError('PROVIDER_MODE_INVALID');
  if (typeof options.cwd !== 'string' || !isAbsolute(options.cwd) || resolve(options.cwd) !== options.cwd) throw new EngineError('PROVIDER_CWD_INVALID');
  for (const key of ['timeoutMs', 'maximumLineBytes', 'maximumStdoutBytes', 'maximumStderrBytes', 'maximumLines']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < 1) throw new EngineError('PROVIDER_BOUND_INVALID');
  }
  if (options.timeoutMs > 3600000 || options.maximumLineBytes > 4194304 || options.maximumStdoutBytes > 33554432 || options.maximumStderrBytes > 1048576 || options.maximumLines > 100000) throw new EngineError('PROVIDER_BOUND_INVALID');
}

function actualSpawnFactory(path, args, options) {
  return spawn(path, args, { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
}

export class IncrementalProviderTransport {
  constructor(plan, options) {
    if (plan === null || typeof plan !== 'object' || !Array.isArray(plan.argv) || plan.argv.some((value) => typeof value !== 'string' || value.includes('\0'))) throw new EngineError('PROVIDER_PLAN_INVALID');
    validateLifecycle(options);
    this.plan = plan;
    this.options = options;
    this.processFactory = options.processFactory ?? actualSpawnFactory;
    this.child = null;
    this.started = false;
    this.lifecycle = 'IDLE';
    this.closedObserved = false;
    this.cancelled = false;
    this.expectedShutdown = false;
    this.terminalError = null;
    this.messageChain = Promise.resolve();
    this.runPromise = null;
    this.timer = null;
    this.handlers = null;
    this.writeWaiters = new Set();
    this.stopSignalled = false;
    this.stopRequested = new Promise((resolveStop) => { this.resolveStop = resolveStop; });
  }

  async start(handlers) {
    if (this.started || handlers === null || typeof handlers !== 'object' || typeof handlers.onMessage !== 'function' || typeof handlers.onExit !== 'function' || typeof handlers.onError !== 'function' || typeof handlers.isComplete !== 'function') throw new EngineError('PROVIDER_TRANSPORT_START_INVALID');
    this.started = true;
    this.handlers = handlers;
    let resolveStarted;
    let rejectStarted;
    const started = new Promise((resolveValue, rejectValue) => { resolveStarted = resolveValue; rejectStarted = rejectValue; });
    this.runPromise = withPinnedExecutable(this.plan.pin, async (path) => {
      let child;
      try { child = this.processFactory(path, this.plan.argv, { cwd: this.options.cwd, env: this.options.env }); }
      catch { throw new EngineError('PROVIDER_PROCESS_START_FAILED'); }
      if (!(child instanceof EventEmitter) || child.stdin === undefined || child.stdout === undefined || child.stderr === undefined || typeof child.kill !== 'function') throw new EngineError('PROVIDER_PROCESS_INTERFACE_INVALID');
      this.child = child;
      this.lifecycle = 'ACTIVE';
      const framer = new BoundedNdjsonFramer({ maximumLineBytes: this.options.maximumLineBytes, maximumTotalBytes: this.options.maximumStdoutBytes, maximumLines: this.options.maximumLines });
      const stderrDigest = new BoundedStderrDigest(this.options.maximumStderrBytes);
      child.stdout.on('data', (chunk) => {
        try {
          this.#armTimeout();
          for (const message of framer.push(chunk)) {
            this.messageChain = this.messageChain.then(() => handlers.onMessage(message));
            this.messageChain.catch((error) => this.#fail(error));
          }
        } catch (error) { this.#fail(error); }
      });
      child.stderr.on('data', (chunk) => { try { this.#armTimeout(); stderrDigest.push(chunk); } catch (error) { this.#fail(error); } });
      const close = new Promise((resolveClose) => {
        child.once('error', () => this.#fail(new EngineError('PROVIDER_PROCESS_ERROR')));
        child.once('close', (code, signal) => {
          this.closedObserved = true;
          this.#settleWriteWaiters(new EngineError('PROVIDER_TRANSPORT_TERMINATED'));
          resolveClose({ code, signal });
        });
      });
      this.#armTimeout();
      resolveStarted();
      let outcome;
      try { outcome = await this.#awaitBoundedClose(close); }
      finally {
        clearTimeout(this.timer);
        this.timer = null;
      }
      await this.messageChain;
      if (this.terminalError !== null) throw this.terminalError;
      const stdout = framer.finish();
      const stderr = stderrDigest.finish();
      if (this.options.mode === 'PERSISTENT' && !this.expectedShutdown) throw new EngineError('PROVIDER_EXIT_PREMATURE');
      if (this.options.mode === 'ONESHOT' && !handlers.isComplete()) throw new EngineError('PROVIDER_EXIT_BEFORE_RESULT');
      if (!Number.isInteger(outcome.code) && !(this.expectedShutdown && typeof outcome.signal === 'string')) throw new EngineError('PROVIDER_EXIT_SIGNALLED');
      return Object.freeze({ exit_code: Number.isInteger(outcome.code) ? outcome.code : -1, stdout, stderr, cancelled: this.cancelled });
    }).finally(() => {
      clearTimeout(this.timer);
      this.timer = null;
      this.#settleWriteWaiters(new EngineError('PROVIDER_TRANSPORT_TERMINATED'));
      if (this.closedObserved) {
        this.child = null;
        this.lifecycle = 'IDLE';
      } else this.lifecycle = 'DRAINING';
    });
    this.runPromise.catch((error) => rejectStarted(error));
    this.runPromise.then((summary) => handlers.onExit(summary), (error) => handlers.onError(new EngineError(errorCode(error))));
    await started;
  }

  async writeObject(value) {
    if (!this.started || this.lifecycle !== 'ACTIVE' || this.child === null || this.cancelled) throw new EngineError('PROVIDER_TRANSPORT_NOT_WRITABLE');
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, 'utf8');
    if (bytes.length - 1 > this.options.maximumLineBytes) throw new EngineError('PROVIDER_STDIN_LINE_OVERSIZE');
    this.#armTimeout();
    if (this.child.stdin.write(bytes)) return;
    await this.#waitForDrain(this.child);
  }

  endInput() {
    if (!this.started || this.lifecycle !== 'ACTIVE' || this.child === null || this.cancelled) throw new EngineError('PROVIDER_TRANSPORT_NOT_WRITABLE');
    this.child.stdin.end();
  }

  cancel() {
    if (!this.started || this.lifecycle !== 'ACTIVE' || this.child === null || this.cancelled) return false;
    this.cancelled = true;
    this.expectedShutdown = true;
    this.lifecycle = 'DRAINING';
    this.#signalStop();
    this.#settleWriteWaiters(new EngineError('PROVIDER_TRANSPORT_CANCELLED'));
    this.child.kill('SIGTERM');
    return true;
  }

  shutdown() {
    this.expectedShutdown = true;
    return this.cancel();
  }

  completion() {
    if (this.runPromise === null) throw new EngineError('PROVIDER_TRANSPORT_NOT_STARTED');
    return this.runPromise;
  }

  isDrained() { return this.lifecycle === 'IDLE' && this.child === null && this.closedObserved; }

  memorySummary() {
    return Object.freeze({ lifecycle: this.lifecycle, started: this.started, cancelled: this.cancelled, closed_observed: this.closedObserved, pending_writes: this.writeWaiters.size });
  }

  #fail(error) {
    if (this.terminalError === null) this.terminalError = error instanceof EngineError ? error : new EngineError('PROVIDER_TRANSPORT_FAIL_CLOSED');
    if (this.lifecycle === 'ACTIVE') this.lifecycle = 'DRAINING';
    this.#signalStop();
    this.#settleWriteWaiters(this.terminalError);
    if (this.child !== null && !this.cancelled) {
      this.cancelled = true;
      this.child.kill('SIGTERM');
    }
  }

  #signalStop() {
    if (this.stopSignalled) return;
    this.stopSignalled = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.resolveStop();
  }

  #awaitBoundedClose(closePromise) {
    return new Promise((resolveClose, rejectClose) => {
      let settled = false;
      let terminationTimer = null;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(terminationTimer);
        callback(value);
      };
      closePromise.then((outcome) => finish(resolveClose, outcome), (error) => finish(rejectClose, error));
      this.stopRequested.then(() => {
        if (settled) return;
        terminationTimer = setTimeout(() => {
          try { this.child?.kill('SIGKILL'); } catch { /* bounded failure remains fail-closed */ }
          finish(rejectClose, new EngineError('PROVIDER_TERMINATION_TIMEOUT'));
        }, this.options.timeoutMs);
      });
    });
  }

  #waitForDrain(child) {
    return new Promise((resolveDrain, rejectDrain) => {
      const stdin = child.stdin;
      let settled = false;
      let timer = null;
      const cleanup = () => {
        clearTimeout(timer);
        stdin.off('drain', onDrain);
        stdin.off('error', onStreamTerminal);
        stdin.off('close', onStreamTerminal);
        child.off('error', onProcessTerminal);
        child.off('close', onProcessTerminal);
        this.writeWaiters.delete(waiter);
      };
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback(value);
      };
      const onDrain = () => finish(resolveDrain);
      const onStreamTerminal = () => finish(rejectDrain, new EngineError('PROVIDER_STDIN_TERMINATED'));
      const onProcessTerminal = () => finish(rejectDrain, new EngineError('PROVIDER_TRANSPORT_TERMINATED'));
      const waiter = { reject: (error) => finish(rejectDrain, error) };
      this.writeWaiters.add(waiter);
      stdin.once('drain', onDrain);
      stdin.once('error', onStreamTerminal);
      stdin.once('close', onStreamTerminal);
      child.once('error', onProcessTerminal);
      child.once('close', onProcessTerminal);
      timer = setTimeout(() => {
        const error = new EngineError('PROVIDER_STDIN_BACKPRESSURE_TIMEOUT');
        this.#fail(error);
        finish(rejectDrain, error);
      }, this.options.timeoutMs);
      if (this.lifecycle !== 'ACTIVE' || this.child !== child || this.cancelled) waiter.reject(new EngineError('PROVIDER_TRANSPORT_NOT_WRITABLE'));
    });
  }

  #settleWriteWaiters(error) {
    for (const waiter of [...this.writeWaiters]) waiter.reject(error);
  }

  #armTimeout() {
    if (this.lifecycle !== 'ACTIVE') return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.#fail(new EngineError('PROVIDER_TIMEOUT')), this.options.timeoutMs);
  }
}

export function codexAppServerPlan(pin) {
  return Object.freeze({ pin, argv: Object.freeze(['app-server']), protocol: 'OFFICIAL_APP_SERVER_JSONL_HEADER_OMITTED_PERSISTENT' });
}

export function claudeStreamJsonPlan(pin, argv) {
  if (!Array.isArray(argv)) throw new EngineError('CLAUDE_ARGV_INVALID');
  return Object.freeze({ pin, argv: Object.freeze([...argv]), protocol: 'OFFICIAL_CLAUDE_STREAM_JSON_ONESHOT' });
}
