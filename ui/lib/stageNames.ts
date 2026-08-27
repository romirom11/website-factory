/**
 * Pipeline stage → what the factory was actually doing.
 *
 * A queue name (`enrich-socials`, `content-and-design`) is meaningful to
 * whoever wrote the worker and to nobody else. Roman needs to know WHAT step
 * stopped so he can judge whether it matters.
 *
 * Kept in `lib/` as a tiny UI adapter because both server components (the
 * system page, the manual re-run form) and client components (the inbox job
 * card) call it. The actual labels live in the import-free shared registry.
 */
import { jobDisplayName } from '@factory/jobDefinitions';

export function stageName(jobType: string): string {
  return jobDisplayName(jobType);
}
