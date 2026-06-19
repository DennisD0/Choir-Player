export type JobStatus = "pending" | "processing" | "done" | "error";

export interface Job {
  id: string;
  status: JobStatus;
  message?: string;
  inputPath: string;
  outputDir: string;
  resultPath?: string;
  error?: string;
  createdAt: number;
}

// In-memory job store. Resets on server restart, which is fine for a
// single-user local OMR tool.
const jobs = new Map<string, Job>();

export function createJob(job: Job): void {
  jobs.set(job.id, job);
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<Job>): void {
  const job = jobs.get(id);
  if (!job) return;
  jobs.set(id, { ...job, ...patch });
}
