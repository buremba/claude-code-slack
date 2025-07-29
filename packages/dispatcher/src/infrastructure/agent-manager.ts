#!/usr/bin/env bun

import type { WorkerJobRequest } from "../types";

/**
 * Abstract interface for managing worker jobs across different infrastructure platforms.
 * This interface provides a common contract for both Kubernetes and Docker implementations.
 */
export interface AgentManager {
  /**
   * Create a new worker job for processing user requests
   * @param request - The job request containing all necessary parameters
   * @returns Promise that resolves to the job ID/name
   */
  createWorkerJob(request: WorkerJobRequest): Promise<string>;

  /**
   * Delete a specific job by name
   * @param jobName - The name/ID of the job to delete
   */
  deleteJob(jobName: string): Promise<void>;

  /**
   * Get the current status of a job
   * @param jobName - The name/ID of the job to check
   * @returns Promise that resolves to the job status
   */
  getJobStatus(jobName: string): Promise<string>;

  /**
   * List all currently active jobs
   * @returns Promise that resolves to an array of active job information
   */
  listActiveJobs(): Promise<Array<{
    name: string;
    sessionKey: string;
    status: string;
  }>>;

  /**
   * Get the count of currently active jobs
   * @returns The number of active jobs
   */
  getActiveJobCount(): number;

  /**
   * Clean up all jobs managed by this instance
   */
  cleanup(): Promise<void>;
}