import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/** Renders for a project; polls while any are running. */
export function useJobs(projectId?: string) {
  return useQuery({
    queryKey: ['jobs', projectId],
    queryFn: () => api.jobs(projectId),
    enabled: !!projectId,
    refetchInterval: (q) => (q.state.data?.some((j) => j.status === 'running' || j.status === 'queued') ? 1000 : false),
  })
}
