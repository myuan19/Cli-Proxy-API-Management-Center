/**
 * 认证文件与 OAuth 排除模型相关 API
 */

import { apiClient } from './client';
import { parseSSE } from './sse';
import type { AuthFilesResponse } from '@/types/authFile';
import type { OAuthModelAliasEntry } from '@/types';

type StatusError = { status?: number };
type AuthFileStatusResponse = { status: string; disabled: boolean };

const getStatusCode = (err: unknown): number | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  if ('status' in err) return (err as StatusError).status;
  return undefined;
};

const normalizeOauthExcludedModels = (payload: unknown): Record<string, string[]> => {
  if (!payload || typeof payload !== 'object') return {};

  const record = payload as Record<string, unknown>;
  const source = record['oauth-excluded-models'] ?? record.items ?? payload;
  if (!source || typeof source !== 'object') return {};

  const result: Record<string, string[]> = {};

  Object.entries(source as Record<string, unknown>).forEach(([provider, models]) => {
    const key = String(provider ?? '')
      .trim()
      .toLowerCase();
    if (!key) return;

    const rawList = Array.isArray(models)
      ? models
      : typeof models === 'string'
        ? models.split(/[\n,]+/)
        : [];

    const seen = new Set<string>();
    const normalized: string[] = [];
    rawList.forEach((item) => {
      const trimmed = String(item ?? '').trim();
      if (!trimmed) return;
      const modelKey = trimmed.toLowerCase();
      if (seen.has(modelKey)) return;
      seen.add(modelKey);
      normalized.push(trimmed);
    });

    result[key] = normalized;
  });

  return result;
};

const normalizeOauthModelAlias = (payload: unknown): Record<string, OAuthModelAliasEntry[]> => {
  if (!payload || typeof payload !== 'object') return {};

  const record = payload as Record<string, unknown>;
  const source =
    record['oauth-model-alias'] ??
    record['oauth-model-mappings'] ??
    record.items ??
    payload;
  if (!source || typeof source !== 'object') return {};

  const result: Record<string, OAuthModelAliasEntry[]> = {};

  Object.entries(source as Record<string, unknown>).forEach(([channel, mappings]) => {
    const key = String(channel ?? '')
      .trim()
      .toLowerCase();
    if (!key) return;
    if (!Array.isArray(mappings)) return;

    const seen = new Set<string>();
    const normalized = mappings
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const entry = item as Record<string, unknown>;
        const name = String(entry.name ?? entry.id ?? entry.model ?? '').trim();
        const alias = String(entry.alias ?? '').trim();
        if (!name || !alias) return null;
        const fork = entry.fork === true;
        return fork ? { name, alias, fork } : { name, alias };
      })
      .filter(Boolean)
      .filter((entry) => {
        const aliasEntry = entry as OAuthModelAliasEntry;
        const dedupeKey = `${aliasEntry.name.toLowerCase()}::${aliasEntry.alias.toLowerCase()}::${aliasEntry.fork ? '1' : '0'}`;
        if (seen.has(dedupeKey)) return false;
        seen.add(dedupeKey);
        return true;
      }) as OAuthModelAliasEntry[];

    if (normalized.length) {
      result[key] = normalized;
    }
  });

  return result;
};

const OAUTH_MODEL_ALIAS_ENDPOINT = '/oauth-model-alias';
const OAUTH_MODEL_MAPPINGS_ENDPOINT = '/oauth-model-mappings';

export const authFilesApi = {
  list: () => apiClient.get<AuthFilesResponse>('/auth-files'),

  setStatus: async (name: string, disabled: boolean) => {
    console.debug('[authFilesApi:setStatus] request name=', name, 'disabled=', disabled);
    const res = await apiClient.patch<AuthFileStatusResponse>('/auth-files/status', { name, disabled });
    console.debug('[authFilesApi:setStatus] response', res);
    return res;
  },

  upload: (file: File) => {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return apiClient.postForm('/auth-files', formData);
  },

  deleteFile: (name: string) => apiClient.delete(`/auth-files?name=${encodeURIComponent(name)}`),

  deleteAll: () => apiClient.delete('/auth-files', { params: { all: true } }),

  downloadText: async (name: string): Promise<string> => {
    const response = await apiClient.getRaw(`/auth-files/download?name=${encodeURIComponent(name)}`, {
      responseType: 'blob',
    });
    const blob = response.data as Blob;
    return blob.text();
  },

  // OAuth 排除模型
  async getOauthExcludedModels(): Promise<Record<string, string[]>> {
    const data = await apiClient.get('/oauth-excluded-models');
    return normalizeOauthExcludedModels(data);
  },

  saveOauthExcludedModels: (provider: string, models: string[]) =>
    apiClient.patch('/oauth-excluded-models', { provider, models }),

  deleteOauthExcludedEntry: (provider: string) =>
    apiClient.delete(`/oauth-excluded-models?provider=${encodeURIComponent(provider)}`),

  replaceOauthExcludedModels: (map: Record<string, string[]>) =>
    apiClient.put('/oauth-excluded-models', normalizeOauthExcludedModels(map)),

  // OAuth 模型别名
  async getOauthModelAlias(): Promise<Record<string, OAuthModelAliasEntry[]>> {
    try {
      const data = await apiClient.get(OAUTH_MODEL_ALIAS_ENDPOINT);
      return normalizeOauthModelAlias(data);
    } catch (err: unknown) {
      if (getStatusCode(err) !== 404) throw err;
      const data = await apiClient.get(OAUTH_MODEL_MAPPINGS_ENDPOINT);
      return normalizeOauthModelAlias(data);
    }
  },

  saveOauthModelAlias: async (channel: string, aliases: OAuthModelAliasEntry[]) => {
    const normalizedChannel = String(channel ?? '')
      .trim()
      .toLowerCase();
    const normalizedAliases =
      normalizeOauthModelAlias({ [normalizedChannel]: aliases })[normalizedChannel] ?? [];

    try {
      await apiClient.patch(OAUTH_MODEL_ALIAS_ENDPOINT, {
        channel: normalizedChannel,
        aliases: normalizedAliases,
      });
      return;
    } catch (err: unknown) {
      if (getStatusCode(err) !== 404) throw err;
      await apiClient.patch(OAUTH_MODEL_MAPPINGS_ENDPOINT, {
        channel: normalizedChannel,
        mappings: normalizedAliases,
      });
    }
  },

  deleteOauthModelAlias: async (channel: string) => {
    const normalizedChannel = String(channel ?? '')
      .trim()
      .toLowerCase();

    const clearViaPatch = async (): Promise<boolean> => {
      try {
        await apiClient.patch(OAUTH_MODEL_ALIAS_ENDPOINT, { channel: normalizedChannel, aliases: [] });
        return true;
      } catch (err: unknown) {
        const status = getStatusCode(err);
        if (status === 405) return false;
        if (status !== 404) throw err;
      }

      try {
        await apiClient.patch(OAUTH_MODEL_MAPPINGS_ENDPOINT, { channel: normalizedChannel, mappings: [] });
        return true;
      } catch (err: unknown) {
        const status = getStatusCode(err);
        if (status === 404 || status === 405) return false;
        throw err;
      }
    };

    const patched = await clearViaPatch();
    if (patched) return;

    try {
      await apiClient.delete(`${OAUTH_MODEL_ALIAS_ENDPOINT}?channel=${encodeURIComponent(normalizedChannel)}`);
      return;
    } catch (err: unknown) {
      const status = getStatusCode(err);
      if (status !== 404) throw err;
    }

    try {
      await apiClient.delete(`${OAUTH_MODEL_MAPPINGS_ENDPOINT}?channel=${encodeURIComponent(normalizedChannel)}`);
    } catch (err: unknown) {
      if (getStatusCode(err) !== 404) throw err;
    }
  },

  // 获取认证凭证支持的模型
  async getModelsForAuthFile(name: string): Promise<{ id: string; display_name?: string; type?: string; owned_by?: string }[]> {
    const data = await apiClient.get(`/auth-files/models?name=${encodeURIComponent(name)}`);
    return data && Array.isArray(data['models']) ? data['models'] : [];
  },

  // 健康检查 - 检查认证文件支持的模型
  async checkModelsHealth(
    name: string,
    options?: {
      concurrent?: boolean;
      timeout?: number;
      model?: string;
      models?: string;
    }
  ): Promise<{
    auth_id: string;
    status: 'healthy' | 'unhealthy' | 'partial';
    proxy_used?: boolean;
    healthy_count: number;
    unhealthy_count: number;
    total_count: number;
    models: Array<{
      model_id: string;
      display_name?: string;
      status: 'healthy' | 'unhealthy';
      message?: string;
      latency_ms?: number;
    }>;
  }> {
    const params = new URLSearchParams();
    params.append('name', name);
    if (options?.concurrent) {
      params.append('concurrent', 'true');
    }
    if (options?.timeout) {
      params.append('timeout', String(options.timeout));
    }
    if (options?.model) {
      params.append('model', options.model);
    }
    if (options?.models) {
      params.append('models', options.models);
    }
    return apiClient.get(`/auth-files/health?${params.toString()}`);
  },

  /**
   * 流式健康检查（当前认证文件下所有模型）：每完成一个就回调，超过 30s 未完成的会收到 status: "timeout"
   */
  async checkModelsHealthStream(
    name: string,
    options: { concurrent?: boolean; timeout?: number },
    callbacks: {
      onMeta?: (meta: { auth_id: string; proxy_used: boolean }) => void;
      onResult: (item: {
        model_id: string;
        display_name?: string;
        status: 'healthy' | 'unhealthy' | 'timeout';
        message?: string;
        latency_ms?: number;
      }) => void;
      onDone: () => void;
    }
  ): Promise<void> {
    const params = new URLSearchParams();
    params.append('name', name);
    params.append('stream', 'true');
    if (options?.concurrent) params.append('concurrent', 'true');
    if (options?.timeout) params.append('timeout', String(options.timeout));
    const path = `auth-files/health?${params.toString()}`;
    const { url, headers } = apiClient.getStreamRequest(path);
    const res = await fetch(url, { headers });
    if (!res.ok || !res.body) {
      throw new Error(res.statusText || 'Stream request failed');
    }
    await parseSSE(res.body, (event, data) => {
      if (event === 'meta' && data && callbacks.onMeta) {
        try {
          callbacks.onMeta(JSON.parse(data) as { auth_id: string; proxy_used: boolean });
        } catch {
          // ignore
        }
      } else if (event === 'result' && data) {
        try {
          callbacks.onResult(JSON.parse(data) as Parameters<typeof callbacks.onResult>[0]);
        } catch {
          // ignore
        }
      } else if (event === 'done') {
        callbacks.onDone();
      }
    });
  },

  // 获取指定 channel 的模型定义
  async getModelDefinitions(channel: string): Promise<{ id: string; display_name?: string; type?: string; owned_by?: string }[]> {
    const normalizedChannel = String(channel ?? '')
      .trim()
      .toLowerCase();
    if (!normalizedChannel) return [];
    const data = await apiClient.get(`/model-definitions/${encodeURIComponent(normalizedChannel)}`);
    return data && Array.isArray(data['models']) ? data['models'] : [];
  },
};
