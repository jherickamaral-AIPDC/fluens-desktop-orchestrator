import { createHash } from 'node:crypto';

export class BridgeError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BridgeError';
    this.code = code;
  }
}

export function errorCode(error) {
  if (error instanceof BridgeError && /^[A-Z0-9_]{3,80}$/.test(error.code)) return error.code;
  return 'INTERNAL_FAIL_CLOSED';
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

export function assertExactKeys(value, expected, code = 'OBJECT_KEYS_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new BridgeError(code);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new BridgeError('CANONICAL_NUMBER_INVALID');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new BridgeError('CANONICAL_VALUE_INVALID');
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isSafeId(value, maximum = 96) {
  return typeof value === 'string' && value.length >= 1 && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value);
}

export function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new BridgeError('OPERATION_ABORTED'));
      return;
    }
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(), milliseconds);
    const abort = () => finish(new BridgeError('OPERATION_ABORTED'));
    signal?.addEventListener('abort', abort, { once: true });
  });
}
