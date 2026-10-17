'use client';

import { runMaintenanceJob } from './actions';

const JOBS = [
  { id: 'reindex', label: 'Reindex artifacts' },
  { id: 'verify', label: 'Verify integrity' },
  { id: 'prune', label: 'Prune expired' },
];

// The maintenance UI is the operator console. Anonymous visitors only get a
// notice — but this module still ships to every browser, and the Server Action
// id is inside its JavaScript.
export function OperatorConsole({ operator }) {
  return (
    <section>
      <h2>Maintenance</h2>
      {operator ? (
        JOBS.map((job) => (
          <button key={job.id} type="button" onClick={() => runMaintenanceJob(job.id)}>
            {job.label}
          </button>
        ))
      ) : (
        <p>Maintenance jobs are available to operator accounts.</p>
      )}
    </section>
  );
}
