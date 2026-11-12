// Presentation only. Preserve every real job, successful file and active operation.
export function downloadCards(jobs) {
  const families = new Map();
  for (const job of jobs) {
    if (typeof job.attempt_id !== 'string' || !/^[a-f0-9]{32}$/.test(job.attempt_id)) continue;
    if (!families.has(job.attempt_id)) families.set(job.attempt_id, []);
    families.get(job.attempt_id).push(job);
  }
  const hidden = new Set(), errors = new Map();
  for (const family of families.values()) {
    const failures = family.filter(job => job.status === 'error');
    const latest = family[family.length - 1];
    if (!failures.length || family.length < 2) continue;
    errors.set(latest.id, failures);
    for (const failure of failures) if (failure.id !== latest.id) hidden.add(failure.id);
  }
  return jobs.filter(job => !hidden.has(job.id)).map(job => ({ ...job, attempt_errors: errors.get(job.id) || [] }));
}
