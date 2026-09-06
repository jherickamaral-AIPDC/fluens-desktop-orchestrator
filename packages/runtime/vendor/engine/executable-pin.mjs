import { open, lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { EngineError, isSha256, sha256Bytes } from './util.mjs';

function validatePin(pin) {
  if (pin === null || typeof pin !== 'object' || Array.isArray(pin)) throw new EngineError('EXECUTABLE_PIN_INVALID');
  const keys = Object.keys(pin).sort();
  if (keys.join(',') !== 'bytes,path,sha256') throw new EngineError('EXECUTABLE_PIN_KEYS_INVALID');
  if (typeof pin.path !== 'string' || !isAbsolute(pin.path) || resolve(pin.path) !== pin.path) throw new EngineError('EXECUTABLE_PATH_NOT_ABSOLUTE');
  if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || !isSha256(pin.sha256)) throw new EngineError('EXECUTABLE_IDENTITY_INVALID');
}

async function readPinned(path) {
  const handle = await open(path, 'r').catch(() => { throw new EngineError('EXECUTABLE_OPEN_FAILED'); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new EngineError('EXECUTABLE_NOT_PLAIN_FILE');
    const pathStat = await lstat(path).catch(() => { throw new EngineError('EXECUTABLE_PATH_INVALID'); });
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || pathStat.dev !== stat.dev || pathStat.ino !== stat.ino) {
      throw new EngineError('EXECUTABLE_PATH_INVALID');
    }
    const bytes = await handle.readFile();
    return { handle, bytes, stat };
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

function assertMatches(pin, record, code) {
  if (record.bytes.length !== pin.bytes || sha256Bytes(record.bytes) !== pin.sha256 || record.stat.size !== pin.bytes) {
    throw new EngineError(code);
  }
}

export async function verifyExecutablePin(pin) {
  validatePin(pin);
  const record = await readPinned(pin.path);
  try {
    assertMatches(pin, record, 'EXECUTABLE_PIN_MISMATCH');
    return Object.freeze({ bytes: pin.bytes, sha256: pin.sha256 });
  } finally {
    await record.handle.close();
  }
}

export async function withPinnedExecutable(pin, invoke) {
  validatePin(pin);
  if (typeof invoke !== 'function') throw new EngineError('EXECUTABLE_INVOKER_INVALID');
  const lease = await readPinned(pin.path);
  try {
    assertMatches(pin, lease, 'EXECUTABLE_PRE_PIN_MISMATCH');
    const result = await invoke(pin.path);
    const post = await readPinned(pin.path);
    try {
      assertMatches(pin, post, 'EXECUTABLE_POST_PIN_MISMATCH');
      if (post.stat.dev !== lease.stat.dev || post.stat.ino !== lease.stat.ino) throw new EngineError('EXECUTABLE_IDENTITY_DRIFT');
    } finally {
      await post.handle.close();
    }
    return result;
  } finally {
    await lease.handle.close();
  }
}
