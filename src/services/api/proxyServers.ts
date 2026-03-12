/**
 * 代理服务器管理 API
 */

import { apiClient } from './client';

export interface ProxyServer {
  id: string;
  prefix: string;
  proxy_url: string;
  proxy_dns?: string;
}

export interface ProxyServersListResponse {
  total: number;
  servers: ProxyServer[];
}

export interface ProxyCheckResponse {
  status: 'healthy' | 'unhealthy';
  message?: string;
  latency_ms?: number;
}

export interface ProxyCheckStreamResult {
  id: string;
  status: 'healthy' | 'unhealthy';
  message?: string;
  latency_ms?: number;
}

export const proxyServersApi = {
  list: () => apiClient.get<ProxyServersListResponse>('/proxy-servers'),

  get: (id: string) => apiClient.get<ProxyServer>(`/proxy-servers/${encodeURIComponent(id)}`),

  create: (data: Omit<ProxyServer, 'id'>) =>
    apiClient.post<ProxyServer>('/proxy-servers', data),

  update: (id: string, data: Omit<ProxyServer, 'id'>) =>
    apiClient.put<ProxyServer>(`/proxy-servers/${encodeURIComponent(id)}`, { ...data, id }),

  delete: (id: string) =>
    apiClient.delete<{ status: string }>(`/proxy-servers/${encodeURIComponent(id)}`),

  check: (id: string) =>
    apiClient.post<ProxyCheckResponse>(`/proxy-servers/${encodeURIComponent(id)}/check`),

  /**
   * Stream check results for all proxy servers via SSE.
   * Calls onResult for each result as it arrives, then onDone when complete.
   */
  async checkAllStream(
    onResult: (result: ProxyCheckStreamResult) => void,
    onDone?: () => void
  ): Promise<void> {
    const { url, headers } = apiClient.getStreamRequest('proxy-servers/check-all');
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok || !res.body) {
      throw new Error(res.statusText || 'Stream request failed');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneCalled = false;
    const doDone = () => {
      if (doneCalled) return;
      doneCalled = true;
      onDone?.();
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split(/\n\n+/);
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          let event = '';
          let data = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data = line.slice(5).trim();
          }
          if (event === 'result' && data) {
            try {
              onResult(JSON.parse(data) as ProxyCheckStreamResult);
            } catch {
              /* ignore */
            }
          } else if (event === 'done') {
            doDone();
          }
        }
      }
      if (buffer.trim()) {
        let event = '';
        let data = '';
        for (const line of buffer.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data = line.slice(5).trim();
        }
        if (event === 'result' && data) {
          try {
            onResult(JSON.parse(data) as ProxyCheckStreamResult);
          } catch {
            /* ignore */
          }
        } else if (event === 'done') {
          doDone();
        }
      }
      doDone();
    } catch (e) {
      throw e;
    }
  },

  applyToAuthFile: (id: string, name: string) =>
    apiClient.post<{ status: string; message?: string }>(
      `/proxy-servers/${encodeURIComponent(id)}/apply/auth-file`,
      { name }
    ),
};
