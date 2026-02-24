/**
 * 请求详情相关 API
 */

import { apiClient } from './client';

export interface DetailedAttempt {
  index: number;
  timestamp?: string;
  upstream_url?: string;
  method?: string;
  auth?: string;
  request_headers?: Record<string, string[]>;
  request_body?: string;
  status_code?: number;
  response_headers?: Record<string, string[]>;
  response_body?: string;
  error?: string;
  duration_ms?: number;
}

export interface DetailedRequestRecord {
  id: string;
  timestamp: string;
  api_key: string;
  api_key_hash: string;
  url: string;
  method: string;
  status_code: number;
  model?: string;
  request_headers?: Record<string, string[]>;
  request_body?: string;
  response_headers?: Record<string, string[]>;
  response_body?: string;
  attempts?: DetailedAttempt[];
  total_duration_ms: number;
  is_streaming: boolean;
  is_simulated?: boolean;
  error?: string;
}

export interface DetailedRequestSummary {
  id: string;
  timestamp: string;
  api_key: string;
  api_key_hash: string;
  url: string;
  method: string;
  status_code: number;
  model?: string;
  total_duration_ms: number;
  is_streaming: boolean;
  is_simulated?: boolean;
  error?: string;
  attempt_count: number;
}

export interface DetailedRequestsListResponse {
  records: DetailedRequestSummary[];
  total: number;
  offset: number;
  limit: number;
  api_keys: string[];
}

export interface DetailedRequestLogStatus {
  'detailed-request-log': boolean;
  'detailed-request-log-max-size-mb': number;
  'detailed-request-log-show-retries'?: boolean;
  'detailed-request-log-show-simulated'?: boolean;
  size_bytes?: number;
  size_mb?: string;
  record_count?: number;
}

export interface DetailedRequestsQuery {
  api_key?: string;
  status_code?: string;
  limit?: number;
  offset?: number;
  after?: number;
  before?: number;
  include_simulated?: boolean;
}

export const detailedRequestsApi = {
  /** 获取详细日志状态 */
  getStatus: (): Promise<DetailedRequestLogStatus> =>
    apiClient.get('/detailed-request-log'),

  /** 开关详细日志 */
  setEnabled: (enabled: boolean): Promise<void> =>
    apiClient.put('/detailed-request-log', { value: enabled }),

  /** 开关「显示重试部分」展示（仅前端展示偏好，与开启详细日志一起持久化） */
  setShowRetries: (show: boolean): Promise<void> =>
    apiClient.put('/detailed-request-log', { show_retries: show }),

  /** 开关「显示模拟路由」展示 */
  setShowSimulated: (show: boolean): Promise<void> =>
    apiClient.put('/detailed-request-log', { show_simulated: show }),

  /** 查询请求记录列表 */
  listRecords: (params: DetailedRequestsQuery = {}): Promise<DetailedRequestsListResponse> =>
    apiClient.get('/detailed-requests', { params }),

  /** 获取单条记录和 cURL 命令 */
  getRecord: (id: string): Promise<{ record: DetailedRequestRecord; curl: string }> =>
    apiClient.get(`/detailed-requests/${encodeURIComponent(id)}`),

  /** 删除所有记录 */
  deleteAll: (): Promise<{ success: boolean; message: string }> =>
    apiClient.delete('/detailed-requests'),
};
