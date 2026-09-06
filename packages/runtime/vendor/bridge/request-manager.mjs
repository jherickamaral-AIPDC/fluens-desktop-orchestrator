import { randomBytes } from 'node:crypto';

import { LIMITS, SCHEMAS } from './contracts.mjs';
import { BridgeError, canonicalJson, sha256Text } from './util.mjs';

function bindingFor(petition, bootGeneration, createGeneration) {
  return sha256Text(canonicalJson({
    boot_generation: bootGeneration,
    chat_id: petition.chatId,
    create_generation: createGeneration,
    peticion_id: petition.peticionId
  }));
}

function safeBootGeneration(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,96}$/.test(value);
}

export class MetadataLedger {
  #records = [];

  add(record) {
    const keys = Object.keys(record);
    if (keys.some((key) => !['kind', 'binding_sha256', 'payload_bytes', 'event_count', 'terminal_kind', 'output_sha256'].includes(key))) {
      throw new BridgeError('METADATA_KEYS_INVALID');
    }
    this.#records.push(Object.freeze({ ...record }));
    if (this.#records.length > LIMITS.metadataEntries) this.#records.shift();
  }

  snapshot() {
    return this.#records.map((record) => ({ ...record }));
  }
}

export class RequestManager {
  #driver;
  #requestTimeoutMs;
  #pollTimeoutMs;
  #driverDrainTimeoutMs;
  #bootGeneration;
  #nextCreateGeneration = 0;
  #entries = new Map();
  #active = null;
  #metadata;
  #effects = { provider: 0, process: 0, network_external: 0, durable_write: 0 };

  constructor({
    driver,
    requestTimeoutMs = 30000,
    pollTimeoutMs = 250,
    driverDrainTimeoutMs = 1000,
    bootGeneration = randomBytes(16).toString('hex'),
    metadata = new MetadataLedger()
  }) {
    if (!driver || driver.kind !== 'DETERMINISTIC_MOCK_DRIVER' || typeof driver.run !== 'function') {
      throw new BridgeError('DRIVER_NOT_MOCK');
    }
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 300000) throw new BridgeError('REQUEST_TIMEOUT_INVALID');
    if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs < 10 || pollTimeoutMs > 5000) throw new BridgeError('POLL_TIMEOUT_INVALID');
    if (!Number.isSafeInteger(driverDrainTimeoutMs) || driverDrainTimeoutMs < 10 || driverDrainTimeoutMs > 5000) throw new BridgeError('DRIVER_DRAIN_TIMEOUT_INVALID');
    if (!safeBootGeneration(bootGeneration)) throw new BridgeError('BOOT_GENERATION_INVALID');
    this.#driver = driver;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#pollTimeoutMs = pollTimeoutMs;
    this.#driverDrainTimeoutMs = driverDrainTimeoutMs;
    this.#bootGeneration = bootGeneration;
    this.#metadata = metadata;
  }

  status() {
    return this.#active === null ? 'listo' : 'ocupado';
  }

  effects() {
    return { ...this.#effects };
  }

  metadata() {
    return this.#metadata.snapshot();
  }

  create(petition, payloadBytes) {
    if (this.#active !== null) throw new BridgeError('REQUEST_BUSY');
    this.#prune();
    if (this.#entries.has(petition.peticionId)) throw new BridgeError('REQUEST_ID_REUSED');
    if (this.#nextCreateGeneration >= Number.MAX_SAFE_INTEGER) throw new BridgeError('CREATE_GENERATION_EXHAUSTED');
    this.#nextCreateGeneration += 1;

    const controller = new AbortController();
    let resolveTerminalReady;
    const terminalReady = new Promise((resolve) => { resolveTerminalReady = resolve; });
    const entry = {
      requestId: petition.peticionId,
      chatId: petition.chatId,
      binding: bindingFor(petition, this.#bootGeneration, this.#nextCreateGeneration),
      controller,
      events: [],
      nextCursor: 0,
      lastReturnedCursor: -1,
      nextPollSequence: 0,
      pollPending: false,
      terminal: false,
      terminalKind: null,
      terminalRequest: null,
      terminalReady,
      resolveTerminalReady,
      terminalReadyResolved: false,
      driverSettled: false,
      outputBytes: 0,
      work: null,
      timer: null,
      drainTimer: null,
      waiters: new Set(),
      terminalDelivered: false
    };
    this.#entries.set(petition.peticionId, entry);
    this.#active = entry;
    this.#metadata.add({ kind: 'request_created', binding_sha256: entry.binding, payload_bytes: payloadBytes });
    entry.timer = setTimeout(() => this.#stageTerminal(entry, 'error', 'REQUEST_TIMEOUT'), this.#requestTimeoutMs);
    const sink = Object.freeze({
      token: (text) => this.#token(entry, text),
      finish: (text) => this.#finish(entry, text),
      fail: (code) => this.#stageTerminal(entry, 'error', code)
    });
    entry.work = Promise.resolve()
      .then(() => this.#driver.run(petition, sink, controller.signal))
      .catch((error) => this.#driverFailed(entry, error))
      .finally(() => this.#driverSettled(entry));
    return { schema: SCHEMAS.createResponse, accepted: true, binding_sha256: entry.binding };
  }

  async poll(request, disconnectSignal) {
    const entry = this.#correlate(request.peticion_id, request.chat_id, request.binding_sha256);
    if (request.cursor !== entry.lastReturnedCursor) throw new BridgeError('POLL_CURSOR_REPLAY_OR_GAP');
    if (request.poll_sequence !== entry.nextPollSequence) throw new BridgeError('POLL_SEQUENCE_REPLAY_OR_GAP');
    if (entry.pollPending) throw new BridgeError('POLL_ALREADY_PENDING');
    entry.pollPending = true;
    entry.nextPollSequence += 1;
    try {
      if (!this.#hasAfter(entry, request.cursor) && !entry.terminal) await this.#waitForEvent(entry, disconnectSignal);
      const events = entry.events.filter((event) => event.cursor > request.cursor).slice(0, LIMITS.eventsPerPoll);
      if (events.length > 0) entry.lastReturnedCursor = events[events.length - 1].cursor;
      const terminalIncluded = events.some((event) => event.kind !== 'token');
      if (terminalIncluded) entry.terminalDelivered = true;
      return {
        schema: SCHEMAS.pollResponse,
        binding_sha256: entry.binding,
        poll_sequence: request.poll_sequence,
        events: events.map((event) => ({ ...event })),
        terminal: entry.terminal && terminalIncluded
      };
    } finally {
      entry.pollPending = false;
    }
  }

  async cancel(request) {
    const entry = this.#correlate(request.peticion_id, request.chat_id, request.binding_sha256);
    if (!entry.terminal && entry.terminalRequest === null) this.#stageTerminal(entry, 'cancelled', 'REQUEST_CANCELLED');
    await entry.terminalReady;
    return { schema: SCHEMAS.cancelResponse, binding_sha256: entry.binding, terminal: true };
  }

  async clientDisconnected(requestId) {
    const entry = this.#entries.get(requestId);
    if (!entry || entry.terminal) return;
    if (entry.terminalRequest === null) this.#stageTerminal(entry, 'error', 'CLIENT_DISCONNECTED');
    await entry.terminalReady;
  }

  async abortAll() {
    const terminals = [];
    for (const entry of this.#entries.values()) {
      if (!entry.terminal && entry.terminalRequest === null) this.#stageTerminal(entry, 'error', 'SERVER_ABORTED');
      if (entry.work && !entry.driverSettled) terminals.push(entry.terminalReady);
    }
    await Promise.all(terminals);
    if (this.#active !== null) throw new BridgeError('DRAIN_INCOMPLETE');
  }

  liveWorkCount() {
    return this.#active === null ? 0 : 1;
  }

  #correlate(id, chatId, binding) {
    const entry = this.#entries.get(id);
    if (!entry || entry.chatId !== chatId || entry.binding !== binding) throw new BridgeError('REQUEST_UNCORRELATED');
    return entry;
  }

  #token(entry, text) {
    if (entry.terminal || entry.terminalRequest !== null) return false;
    const bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : -1;
    if (typeof text !== 'string' || text.length === 0 || bytes > LIMITS.tokenBytes) {
      this.#stageTerminal(entry, 'error', 'TOKEN_INVALID');
      return false;
    }
    if (entry.outputBytes + bytes > LIMITS.outputBytes) {
      this.#stageTerminal(entry, 'error', 'OUTPUT_LIMIT');
      return false;
    }
    if (entry.events.length >= LIMITS.events - 1) {
      this.#stageTerminal(entry, 'error', 'EVENT_LIMIT');
      return false;
    }
    entry.outputBytes += bytes;
    this.#append(entry, { kind: 'token', text });
    return true;
  }

  #finish(entry, text) {
    if (entry.terminal || entry.terminalRequest !== null) return false;
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > LIMITS.outputBytes) {
      this.#stageTerminal(entry, 'error', 'OUTPUT_INVALID');
      return false;
    }
    return this.#stageTerminal(entry, 'finished', text);
  }

  #stageTerminal(entry, kind, value) {
    if (entry.terminal || entry.terminalRequest !== null) return false;
    if (kind === 'finished') {
      if (typeof value !== 'string') {
        kind = 'error';
        value = 'DRIVER_FAILURE';
      }
    } else if (!['error', 'cancelled'].includes(kind) || typeof value !== 'string' || !/^[A-Z0-9_]{3,80}$/.test(value)) {
      kind = 'error';
      value = 'DRIVER_FAILURE';
    }
    entry.terminalRequest = { kind, value };
    clearTimeout(entry.timer);
    if (kind !== 'finished') entry.controller.abort();
    entry.drainTimer = setTimeout(() => this.#drainTimedOut(entry), this.#driverDrainTimeoutMs);
    if (entry.driverSettled) {
      clearTimeout(entry.drainTimer);
      entry.drainTimer = null;
      this.#commitTerminal(entry);
    }
    return true;
  }

  #driverFailed(entry, error) {
    if (entry.terminal) return;
    if (entry.terminalRequest?.kind === 'finished') {
      entry.terminalRequest = { kind: 'error', value: error instanceof BridgeError ? error.code : 'DRIVER_FAILURE' };
      entry.controller.abort();
      return;
    }
    if (entry.terminalRequest === null) this.#stageTerminal(entry, 'error', error instanceof BridgeError ? error.code : 'DRIVER_FAILURE');
  }

  #driverSettled(entry) {
    entry.driverSettled = true;
    clearTimeout(entry.drainTimer);
    entry.drainTimer = null;
    if (!entry.terminal && entry.terminalRequest === null) this.#stageTerminal(entry, 'error', 'DRIVER_TERMINATED_WITHOUT_RESULT');
    if (!entry.terminal) this.#commitTerminal(entry);
    this.#maybeRelease(entry);
    this.#notify(entry);
  }

  #drainTimedOut(entry) {
    entry.drainTimer = null;
    if (entry.terminal || entry.driverSettled) return;
    entry.terminalRequest = { kind: 'error', value: 'DRIVER_DRAIN_TIMEOUT' };
    entry.controller.abort();
    this.#commitTerminal(entry);
  }

  #commitTerminal(entry) {
    if (entry.terminal) return false;
    const request = entry.terminalRequest;
    if (request === null) throw new BridgeError('TERMINAL_REQUEST_MISSING');
    entry.terminal = true;
    entry.terminalKind = request.kind;
    clearTimeout(entry.timer);
    clearTimeout(entry.drainTimer);
    entry.drainTimer = null;
    if (request.kind === 'finished') {
      this.#append(entry, { kind: 'finished', text: request.value });
      this.#metadata.add({ kind: 'request_terminal', binding_sha256: entry.binding, event_count: entry.events.length, terminal_kind: 'finished', output_sha256: sha256Text(request.value) });
    } else {
      this.#append(entry, { kind: request.kind, code: request.value });
      this.#metadata.add({ kind: 'request_terminal', binding_sha256: entry.binding, event_count: entry.events.length, terminal_kind: request.kind, output_sha256: sha256Text('') });
    }
    if (!entry.terminalReadyResolved) {
      entry.terminalReadyResolved = true;
      entry.resolveTerminalReady();
    }
    this.#notify(entry);
    this.#maybeRelease(entry);
    return true;
  }

  #append(entry, body) {
    if (entry.events.length >= LIMITS.events) throw new BridgeError('EVENT_STORAGE_INVARIANT');
    entry.events.push(Object.freeze({ cursor: entry.nextCursor, ...body }));
    entry.nextCursor += 1;
    this.#notify(entry);
  }

  #hasAfter(entry, cursor) {
    return entry.events.some((event) => event.cursor > cursor);
  }

  #waitForEvent(entry, disconnectSignal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.waiters.delete(onEvent);
        disconnectSignal?.removeEventListener('abort', onAbort);
        if (error) reject(error); else resolve();
      };
      const onEvent = () => finish();
      const onAbort = () => finish(new BridgeError('CLIENT_DISCONNECTED'));
      const timer = setTimeout(() => finish(), this.#pollTimeoutMs);
      entry.waiters.add(onEvent);
      if (disconnectSignal?.aborted) onAbort();
      else disconnectSignal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  #notify(entry) {
    for (const waiter of [...entry.waiters]) waiter();
  }

  #maybeRelease(entry) {
    if (entry.terminal && entry.driverSettled && this.#active === entry) this.#active = null;
  }

  #prune() {
    if (this.#entries.size < 32) return;
    for (const [id, entry] of this.#entries) {
      if (entry.terminal && entry.terminalDelivered && entry.driverSettled) {
        this.#entries.delete(id);
        if (this.#entries.size < 32) return;
      }
    }
    throw new BridgeError('REQUEST_HISTORY_FULL');
  }
}
