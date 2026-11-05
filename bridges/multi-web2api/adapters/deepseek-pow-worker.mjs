// WASM interface adapted from FreeTokenAPI; see vendor/README.md and its MIT license.
import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

try {
  const bytes = await readFile(new URL('./vendor/deepseek-sha3.wasm', import.meta.url));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== 'b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d') throw new Error('asset mismatch');
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const { memory, wasm_solve: solve, __wbindgen_add_to_stack_pointer: stack, __wbindgen_export_0: malloc } = instance.exports;
  const challenge = new TextEncoder().encode(workerData.challenge);
  const prefix = new TextEncoder().encode(`${workerData.salt}_${workerData.expire_at}_`);
  const challengePointer = malloc(challenge.length, 1);
  new Uint8Array(memory.buffer).set(challenge, challengePointer);
  const prefixPointer = malloc(prefix.length, 1);
  new Uint8Array(memory.buffer).set(prefix, prefixPointer);
  const resultPointer = stack(-16);
  try {
    solve(resultPointer, challengePointer, challenge.length, prefixPointer, prefix.length, workerData.difficulty);
    const view = new DataView(memory.buffer);
    const answer = view.getInt32(resultPointer, true) ? view.getFloat64(resultPointer + 8, true) : null;
    parentPort.postMessage({ answer });
  } finally { stack(16); }
} catch {
  parentPort.postMessage({ error: true });
}
