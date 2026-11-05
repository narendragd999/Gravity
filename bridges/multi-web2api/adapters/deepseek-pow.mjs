import { Worker } from 'node:worker_threads';
import { adapterError } from './direct-http.mjs';

const fail = (code, detail) => adapterError('DeepSeek', 502, code, detail);

export function validateChallenge(challenge, { now = Date.now(), maxDifficulty = 100_000_000 } = {}) {
  if (!challenge || challenge.algorithm !== 'DeepSeekHashV1') throw fail('unsupported_challenge', 'the website requested an unsupported work algorithm.');
  if (!/^[0-9a-f]{64}$/i.test(challenge.challenge || '') || typeof challenge.salt !== 'string' || Buffer.byteLength(challenge.salt) > 4096
    || typeof challenge.signature !== 'string' || !challenge.signature || challenge.signature.length > 8192
    || challenge.target_path !== '/api/v0/chat/completion') throw fail('invalid_challenge', 'the website returned an invalid work challenge.');
  if (!Number.isSafeInteger(challenge.expire_at) || challenge.expire_at <= now) throw fail('expired_challenge', 'the work challenge expired; retry the request.');
  if (!Number.isSafeInteger(challenge.difficulty) || challenge.difficulty <= 0 || challenge.difficulty > maxDifficulty) throw fail('work_limit_exceeded', 'the required work exceeds the configured bridge limit.');
  return challenge;
}

export async function solveDeepSeekChallenge(challenge, { signal, timeoutMs = 30_000, maxDifficulty = 100_000_000 } = {}) {
  validateChallenge(challenge, { maxDifficulty });
  if (signal?.aborted) throw fail('request_aborted', 'the request was cancelled.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./deepseek-pow-worker.mjs', import.meta.url), {
      workerData: { challenge: challenge.challenge, salt: challenge.salt, expire_at: challenge.expire_at, difficulty: challenge.difficulty },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
    let finished = false;
    const finish = (error, answer) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate().catch(() => {});
      error ? reject(error) : resolve(answer);
    };
    const abort = () => finish(fail('request_aborted', 'the request was cancelled.'));
    const timer = setTimeout(() => finish(fail('work_timeout', 'the work challenge exceeded its time limit; retry later.')), Math.max(1, Math.min(timeoutMs, challenge.expire_at - Date.now())));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    worker.once('error', () => finish(fail('work_failed', 'the work runtime failed.')));
    worker.once('exit', () => { if (!finished) finish(fail('work_failed', 'the work runtime stopped unexpectedly.')); });
    worker.once('message', result => {
      const answer = result?.answer;
      if (result?.error || !Number.isSafeInteger(answer) || answer < 0 || answer >= challenge.difficulty) {
        finish(fail('work_failed', 'the website work challenge could not be completed.'));
      } else finish(null, answer);
    });
  });
}

export function proofHeader(challenge, answer) {
  validateChallenge(challenge);
  if (!Number.isSafeInteger(answer) || answer < 0 || answer >= challenge.difficulty) throw fail('invalid_proof', 'the work runtime returned an invalid answer.');
  return Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer, signature: challenge.signature, target_path: challenge.target_path })).toString('base64');
}
