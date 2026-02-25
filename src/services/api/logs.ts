/**
 * 日志相关 API
 */

import { apiClient } from './client';
import { LOGS_TIMEOUT_MS } from '@/utils/constants';

export interface LogsQuery {
  n?: number;
  start?: number;
  end?: number;
}

export interface LogsResponse {
  lines: string[];
  start_line: number;
  end_line: number;
  total_lines: number;
}

export interface ErrorLogFile {
  name: string;
  size?: number;
  modified?: number;
}

export interface ErrorLogsResponse {
  files?: ErrorLogFile[];
}

export const logsApi = {
  fetchLogs: (params: LogsQuery = {}): Promise<LogsResponse> =>
    apiClient.get('/logs', { params, timeout: LOGS_TIMEOUT_MS }),

  clearLogs: () => apiClient.delete('/logs'),

  fetchErrorLogs: (): Promise<ErrorLogsResponse> =>
    apiClient.get('/request-error-logs', { timeout: LOGS_TIMEOUT_MS }),

  downloadErrorLog: (filename: string) =>
    apiClient.getRaw(`/request-error-logs/${encodeURIComponent(filename)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  downloadRequestLogById: (id: string) =>
    apiClient.getRaw(`/request-log-by-id/${encodeURIComponent(id)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),
};
