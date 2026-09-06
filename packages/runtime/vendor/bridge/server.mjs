import http from 'node:http';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { API_PREFIX, LIMITS, SCHEMAS, assertCancel, assertCreate, assertPoll, assertStatus } from './contracts.mjs';
import { parseStrictJson, decodeStrictUtf8 } from './strict-json.mjs';
import { RequestManager } from './request-manager.mjs';
import { BridgeError, canonicalJson, errorCode, sha256Bytes } from './util.mjs';

const STATIC_FILES = Object.freeze({
  '/': Object.freeze({ relative: 'index.html', type: 'text/html; charset=utf-8' }),
  '/index.html': Object.freeze({ relative: 'index.html', type: 'text/html; charset=utf-8' }),
  '/motor.js': Object.freeze({ relative: 'motor.js', type: 'text/javascript; charset=utf-8' }),
  '/css/app.css': Object.freeze({ relative: 'css/app.css', type: 'text/css; charset=utf-8' }),
  '/js/app.js': Object.freeze({ relative: 'js/app.js', type: 'text/javascript; charset=utf-8' }),
  '/js/db.js': Object.freeze({ relative: 'js/db.js', type: 'text/javascript; charset=utf-8' }),
  '/js/md.js': Object.freeze({ relative: 'js/md.js', type: 'text/javascript; charset=utf-8' })
});
const EXPECTED_UI_DIRECTORIES = new Set(['css', 'js']);

function headerValues(request, wanted) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === wanted) values.push(request.rawHeaders[index + 1]);
  }
  return values;
}

function exactHeader(request, name, expected, required = true) {
  const values = headerValues(request, name);
  if (values.length === 0 && !required) return;
  if (values.length !== 1 || values[0] !== expected) throw new BridgeError(`${name.toUpperCase()}_INVALID`);
}

function exactRawPath(request) {
  const raw = request.url;
  if (typeof raw !== 'string' || raw.length < 1 || raw.length > 256 || raw.includes('%') || raw.includes('\\') || raw.includes('?') || raw.includes('#') || /[\x00-\x20\x7f]/.test(raw) || !raw.startsWith('/')) {
    throw new BridgeError('URL_PATH_INVALID');
  }
  return raw;
}

async function assertPlainDirectory(directory, code) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BridgeError(code);
  const canonical = await realpath(directory);
  if (path.resolve(canonical) !== path.resolve(directory)) throw new BridgeError(code);
}

async function inventory(root) {
  const records = [];
  async function walk(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new BridgeError('UI_REPARSE_FORBIDDEN');
      if (entry.isDirectory()) {
        records.push({ relative, directory: true });
        await walk(absolute, relative);
      } else if (entry.isFile()) records.push({ relative, directory: false });
      else throw new BridgeError('UI_ENTRY_TYPE_INVALID');
    }
  }
  await walk(root, '');
  return records;
}

export async function validateUiRoot(uiRoot, expectedPins) {
  if (typeof uiRoot !== 'string' || !path.isAbsolute(uiRoot) || expectedPins === null || typeof expectedPins !== 'object' || Array.isArray(expectedPins)) throw new BridgeError('UI_ROOT_CONFIG_INVALID');
  await assertPlainDirectory(uiRoot, 'UI_ROOT_INVALID');
  const records = await inventory(uiRoot);
  const expectedFiles = Object.keys(expectedPins).sort();
  const actualFiles = records.filter((record) => !record.directory).map((record) => record.relative).sort();
  const actualDirectories = records.filter((record) => record.directory).map((record) => record.relative).sort();
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) throw new BridgeError('UI_INVENTORY_INVALID');
  if (actualDirectories.length !== EXPECTED_UI_DIRECTORIES.size || actualDirectories.some((directory) => !EXPECTED_UI_DIRECTORIES.has(directory))) throw new BridgeError('UI_DIRECTORY_INVENTORY_INVALID');
  for (const relative of expectedFiles) {
    const absolute = path.join(uiRoot, ...relative.split('/'));
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink()) throw new BridgeError('UI_FILE_INVALID');
    const handle = await open(absolute, fsConstants.O_RDONLY);
    try {
      const bytes = await handle.readFile();
      const pin = expectedPins[relative];
      if (!pin || bytes.length !== pin.bytes || sha256Bytes(bytes) !== pin.sha256) throw new BridgeError('UI_PIN_INVALID');
    } finally { await handle.close(); }
  }
  return true;
}

async function readStatic(uiRoot, mapping, expectedPin) {
  const absolute = path.resolve(uiRoot, ...mapping.relative.split('/'));
  const prefix = `${path.resolve(uiRoot)}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new BridgeError('STATIC_CONTAINMENT_INVALID');
  const parent = path.dirname(absolute);
  await assertPlainDirectory(parent, 'STATIC_PARENT_INVALID');
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink()) throw new BridgeError('STATIC_FILE_INVALID');
  const handle = await open(absolute, fsConstants.O_RDONLY);
  try {
    const handleInfo = await handle.stat();
    const bytes = await handle.readFile();
    const after = await lstat(absolute);
    if (!handleInfo.isFile() || !after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== handleInfo.size) throw new BridgeError('STATIC_SOURCE_DRIFT');
    if (!expectedPin || bytes.length !== expectedPin.bytes || sha256Bytes(bytes) !== expectedPin.sha256) throw new BridgeError('STATIC_PIN_INVALID');
    return bytes;
  } finally { await handle.close(); }
}

async function readBody(request, maximumBytes, timeoutMs, shutdownSignal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
      shutdownSignal?.removeEventListener('abort', onShutdown);
      if (error) {
        if (!request.destroyed) request.destroy();
        reject(error);
      } else resolve(Buffer.concat(chunks, total));
    };
    const onData = (chunk) => {
      total += chunk.length;
      if (total > maximumBytes) finish(new BridgeError('BODY_OVERSIZE'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new BridgeError('BODY_ABORTED'));
    const onError = () => finish(new BridgeError('BODY_READ_FAILED'));
    const onShutdown = () => finish(new BridgeError('SERVER_DRAINING'));
    const timer = setTimeout(() => finish(new BridgeError('BODY_TIMEOUT')), timeoutMs);
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
    if (shutdownSignal?.aborted) onShutdown();
    else shutdownSignal?.addEventListener('abort', onShutdown, { once: true });
  });
}

function bounded(promise, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new BridgeError(code)), timeoutMs);
    Promise.resolve(promise).then((value) => finish(null, value), (error) => finish(error));
  });
}

async function waitWritable(response, timeoutMs = 1000) {
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off('drain', onDrain);
      response.off('close', onClose);
      if (error) reject(error); else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(new BridgeError('RESPONSE_CLOSED'));
    const timer = setTimeout(() => finish(new BridgeError('RESPONSE_BACKPRESSURE_TIMEOUT')), timeoutMs);
    response.once('drain', onDrain);
    response.once('close', onClose);
  });
}

export async function writeBoundedJson(response, status, value) {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  if (bytes.length > LIMITS.bodyBytes) throw new BridgeError('RESPONSE_OVERSIZE');
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(bytes.length));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (!response.write(bytes)) await waitWritable(response);
  response.end();
}

async function writeStatic(response, method, mapping, bytes) {
  response.statusCode = 200;
  response.setHeader('Content-Type', mapping.type);
  response.setHeader('Content-Length', String(bytes.length));
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  if (method === 'HEAD') response.end();
  else {
    if (!response.write(bytes)) await waitWritable(response);
    response.end();
  }
}

function statusFor(code) {
  if (code === 'REQUEST_BUSY') return 409;
  if (code === 'REQUEST_UNCORRELATED') return 404;
  if (code.includes('METHOD')) return 405;
  if (code.includes('HOST') || code.includes('ORIGIN')) return 403;
  return 400;
}

export async function createBridgeServer(options) {
  const {
    host,
    port,
    uiRoot,
    expectedUiPins,
    driver,
    requestTimeoutMs = 30000,
    pollTimeoutMs = 250,
    driverDrainTimeoutMs = 1000,
    bodyReadTimeoutMs = 1000,
    shutdownTimeoutMs = 5000,
    bootGeneration
  } = options;
  if (host !== '127.0.0.1' || !Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new BridgeError('LISTEN_CONFIG_INVALID');
  if (!Number.isSafeInteger(bodyReadTimeoutMs) || bodyReadTimeoutMs < 10 || bodyReadTimeoutMs > 5000) throw new BridgeError('BODY_TIMEOUT_CONFIG_INVALID');
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100 || shutdownTimeoutMs > 10000) throw new BridgeError('SHUTDOWN_TIMEOUT_CONFIG_INVALID');
  await validateUiRoot(uiRoot, expectedUiPins);
  const manager = new RequestManager({ driver, requestTimeoutMs, pollTimeoutMs, driverDrainTimeoutMs, bootGeneration });
  const ownHost = `${host}:${port}`;
  const ownOrigin = `http://${ownHost}`;
  let stopping = false;
  let started = false;
  let stopPromise = null;
  const sockets = new Set();
  const handlers = new Set();
  const handlerControllers = new Set();

  async function handleRequest(request, response, handlerSignal) {
    let parsedRequestId = null;
    try {
      exactHeader(request, 'host', ownHost, true);
      const rawPath = exactRawPath(request);
      if (rawPath.startsWith(API_PREFIX)) {
        if (request.method !== 'POST') throw new BridgeError('API_METHOD_INVALID');
        exactHeader(request, 'origin', ownOrigin, true);
        exactHeader(request, 'content-type', 'application/json', true);
        if (stopping) throw new BridgeError('SERVER_DRAINING');
        const rawBody = await readBody(request, LIMITS.bodyBytes, bodyReadTimeoutMs, handlerSignal);
        const body = parseStrictJson(decodeStrictUtf8(rawBody, LIMITS.bodyBytes), { maximumBytes: LIMITS.bodyBytes, maximumDepth: 12, maximumNodes: 4096 });
        if (rawPath === `${API_PREFIX}status`) {
          assertStatus(body);
          await writeBoundedJson(response, 200, { schema: SCHEMAS.status, estado: manager.status(), title_proposals: false, automatic_passes: false });
          return;
        }
        if (rawPath === `${API_PREFIX}request`) {
          const petition = assertCreate(body);
          parsedRequestId = petition.peticionId;
          await writeBoundedJson(response, 202, manager.create(petition, rawBody.length));
          return;
        }
        if (rawPath === `${API_PREFIX}poll`) {
          const poll = assertPoll(body);
          parsedRequestId = poll.peticion_id;
          const disconnect = new AbortController();
          const abortDisconnect = () => disconnect.abort();
          request.once('aborted', abortDisconnect);
          response.once('close', () => { if (!response.writableEnded) abortDisconnect(); });
          handlerSignal.addEventListener('abort', abortDisconnect, { once: true });
          try {
            const result = await manager.poll(poll, disconnect.signal);
            await writeBoundedJson(response, 200, result);
          } finally {
            handlerSignal.removeEventListener('abort', abortDisconnect);
          }
          return;
        }
        if (rawPath === `${API_PREFIX}cancel`) {
          const cancel = assertCancel(body);
          parsedRequestId = cancel.peticion_id;
          await writeBoundedJson(response, 200, await manager.cancel(cancel));
          return;
        }
        throw new BridgeError('API_PATH_INVALID');
      }
      exactHeader(request, 'origin', ownOrigin, false);
      if (!['GET', 'HEAD'].includes(request.method)) throw new BridgeError('STATIC_METHOD_INVALID');
      const mapping = STATIC_FILES[rawPath];
      if (!mapping) throw new BridgeError('STATIC_PATH_INVALID');
      await writeStatic(response, request.method, mapping, await readStatic(uiRoot, mapping, expectedUiPins[mapping.relative]));
    } catch (error) {
      const code = errorCode(error);
      if (parsedRequestId && ['CLIENT_DISCONNECTED', 'RESPONSE_CLOSED', 'RESPONSE_BACKPRESSURE_TIMEOUT', 'SERVER_DRAINING'].includes(code)) {
        await manager.clientDisconnected(parsedRequestId).catch(() => {});
      }
      if (!response.headersSent && !response.destroyed) {
        await writeBoundedJson(response, statusFor(code), { schema: SCHEMAS.error, error: code }).catch(() => response.destroy());
      } else if (!response.writableEnded) response.destroy();
    }
  }

  const server = http.createServer((request, response) => {
    const controller = new AbortController();
    handlerControllers.add(controller);
    let task;
    task = handleRequest(request, response, controller.signal).finally(() => {
      handlerControllers.delete(controller);
      handlers.delete(task);
    });
    handlers.add(task);
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (stopping) socket.destroy();
  });

  function closeListeningServer() {
    if (!started) return Promise.resolve();
    return new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(new BridgeError('SERVER_CLOSE_FAILED'));
        else resolve();
      });
    });
  }

  function stop() {
    if (stopPromise !== null) return stopPromise;
    stopping = true;
    stopPromise = (async () => {
      const closePromise = closeListeningServer();
      for (const controller of [...handlerControllers]) controller.abort();
      for (const socket of [...sockets]) socket.destroy();
      server.closeAllConnections?.();
      let managerError = null;
      try { await manager.abortAll(); }
      catch (error) { managerError = error; }
      await bounded(closePromise, shutdownTimeoutMs, 'SERVER_CLOSE_TIMEOUT');
      await bounded(Promise.allSettled([...handlers]), shutdownTimeoutMs, 'HANDLER_DRAIN_TIMEOUT');
      if (handlers.size !== 0) throw new BridgeError('HANDLER_DRAIN_INCOMPLETE');
      if (managerError) throw managerError;
      if (manager.liveWorkCount() !== 0) throw new BridgeError('SERVER_DRAIN_INCOMPLETE');
    })();
    return stopPromise;
  }

  return Object.freeze({
    origin: ownOrigin,
    manager,
    async start() {
      if (started || stopping) throw new BridgeError('SERVER_START_STATE_INVALID');
      await new Promise((resolve, reject) => {
        const onError = () => reject(new BridgeError('LISTEN_FAILED'));
        server.once('error', onError);
        server.listen({ host, port, exclusive: true }, () => {
          server.off('error', onError);
          started = true;
          resolve();
        });
      });
      return ownOrigin;
    },
    stop,
    address() { return server.address(); }
  });
}
