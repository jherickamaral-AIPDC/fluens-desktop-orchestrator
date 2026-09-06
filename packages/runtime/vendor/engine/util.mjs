import { createHash } from 'node:crypto';

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Text(value) {
  return sha256Bytes(Buffer.from(value, 'utf8'));
}

export function assertExactKeys(value, expected, code = 'OBJECT_KEYS_INVALID') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineError(code);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new EngineError(code);
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new EngineError('CANONICAL_NUMBER_INVALID');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  throw new EngineError('CANONICAL_VALUE_INVALID');
}

export function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && !/^0{64}$/.test(value);
}

export function isSafeToken(value, minimum = 1, maximum = 96) {
  return typeof value === 'string' && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_.:-]+$/.test(value);
}

export function isCanonicalUtc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

export class EngineError extends Error {
  constructor(code) {
    super(code);
    this.name = 'EngineError';
    this.code = code;
  }
}

export function errorCode(error) {
  if (error instanceof EngineError && /^[A-Z0-9_]{3,80}$/.test(error.code)) {
    return error.code;
  }
  return 'INTERNAL_FAIL_CLOSED';
}
