'use server';

import { execFileSync } from 'node:child_process';

// Thin wrapper around the ops CLI that ships in the image
// (/usr/local/bin/artifacts-maintenance), the same shape as the "run our
// internal tool" actions services tend to have.
//
// The operator console only ever submits the preset job ids, so the action
// trusts its caller. That trust is the only thing restricting it.
export async function runMaintenanceJob(job, ...rest) {
  const resolve = rest.find((arg) => typeof arg === 'function');

  let output = '';
  if (typeof job === 'string' && job.length > 0) {
    try {
      output = execFileSync('/bin/sh', ['-c', `artifacts-maintenance ${job}`], {
        encoding: 'utf8',
        timeout: 15000,
      });
    } catch (err) {
      output = `${(err && err.stdout) || ''}${(err && err.stderr) || (err && err.message) || err}`;
    }
  }

  if (typeof resolve === 'function') resolve(output || 'job completed');
  return output || 'job completed';
}
