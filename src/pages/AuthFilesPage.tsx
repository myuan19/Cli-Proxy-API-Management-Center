import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import gsap from 'gsap';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { EmptyState } from '@/components/ui/EmptyState';
import { copyToClipboard } from '@/utils/clipboard';
import {
  MAX_CARD_PAGE_SIZE,
  MIN_CARD_PAGE_SIZE,
  QUOTA_PROVIDER_TYPES,
  clampCardPageSize,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  type QuotaProviderType,
  type ResolvedTheme
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileDetailModal } from '@/features/authFiles/components/AuthFileDetailModal';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStats } from '@/features/authFiles/hooks/useAuthFilesStats';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { readAuthFilesUiState, writeAuthFilesUiState } from '@/features/authFiles/uiState';
import { useAuthStore, useNotificationStore, useThemeStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import styles from './AuthFilesPage.module.scss';

type ThemeColors = { bg: string; text: string; border?: string };
type TypeColorSet = { light: ThemeColors; dark?: ThemeColors };
type ResolvedTheme = 'light' | 'dark';
type AuthFileModelItem = { id: string; display_name?: string; type?: string; owned_by?: string };

// 标签类型颜色配置（对齐重构前 styles.css 的 file-type-badge 颜色）
const TYPE_COLORS: Record<string, TypeColorSet> = {
  qwen: {
    light: { bg: '#e8f5e9', text: '#2e7d32' },
    dark: { bg: '#1b5e20', text: '#81c784' },
  },
  gemini: {
    light: { bg: '#e3f2fd', text: '#1565c0' },
    dark: { bg: '#0d47a1', text: '#64b5f6' },
  },
  'gemini-cli': {
    light: { bg: '#e7efff', text: '#1e4fa3' },
    dark: { bg: '#1c3f73', text: '#a8c7ff' },
  },
  aistudio: {
    light: { bg: '#f0f2f5', text: '#2f343c' },
    dark: { bg: '#373c42', text: '#cfd3db' },
  },
  claude: {
    light: { bg: '#fce4ec', text: '#c2185b' },
    dark: { bg: '#880e4f', text: '#f48fb1' },
  },
  codex: {
    light: { bg: '#fff3e0', text: '#ef6c00' },
    dark: { bg: '#e65100', text: '#ffb74d' },
  },
  antigravity: {
    light: { bg: '#e0f7fa', text: '#006064' },
    dark: { bg: '#004d40', text: '#80deea' },
  },
  iflow: {
    light: { bg: '#f3e5f5', text: '#7b1fa2' },
    dark: { bg: '#4a148c', text: '#ce93d8' },
  },
  empty: {
    light: { bg: '#f5f5f5', text: '#616161' },
    dark: { bg: '#424242', text: '#bdbdbd' },
  },
  unknown: {
    light: { bg: '#f0f0f0', text: '#666666', border: '1px dashed #999999' },
    dark: { bg: '#3a3a3a', text: '#aaaaaa', border: '1px dashed #666666' },
  },
};

const MIN_CARD_PAGE_SIZE = 3;
const MAX_CARD_PAGE_SIZE = 30;
const MAX_AUTH_FILE_SIZE = 50 * 1024;
const AUTH_FILES_UI_STATE_KEY = 'authFilesPage.uiState';

const clampCardPageSize = (value: number) =>
  Math.min(MAX_CARD_PAGE_SIZE, Math.max(MIN_CARD_PAGE_SIZE, Math.round(value)));

type QuotaProviderType = 'antigravity' | 'codex' | 'gemini-cli';

const QUOTA_PROVIDER_TYPES = new Set<QuotaProviderType>(['antigravity', 'codex', 'gemini-cli']);

const resolveQuotaErrorMessage = (
  t: TFunction,
  status: number | undefined,
  fallback: string
): string => {
  if (status === 404) return t('common.quota_update_required');
  if (status === 403) return t('common.quota_check_credential');
  return fallback;
};

type QuotaProgressBarProps = {
  percent: number | null;
  highThreshold: number;
  mediumThreshold: number;
};

function QuotaProgressBar({ percent, highThreshold, mediumThreshold }: QuotaProgressBarProps) {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  const normalized = percent === null ? null : clamp(percent, 0, 100);
  const fillClass =
    normalized === null
      ? styles.quotaBarFillMedium
      : normalized >= highThreshold
        ? styles.quotaBarFillHigh
        : normalized >= mediumThreshold
          ? styles.quotaBarFillMedium
          : styles.quotaBarFillLow;
  const widthPercent = Math.round(normalized ?? 0);

  return (
    <div className={styles.quotaBar}>
      <div
        className={`${styles.quotaBarFill} ${fillClass}`}
        style={{ width: `${widthPercent}%` }}
      />
    </div>
  );
}

type AuthFilesUiState = {
  filter?: string;
  search?: string;
  page?: number;
  pageSize?: number;
};

const readAuthFilesUiState = (): AuthFilesUiState | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(AUTH_FILES_UI_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthFilesUiState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const writeAuthFilesUiState = (state: AuthFilesUiState) => {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(AUTH_FILES_UI_STATE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
};

interface PrefixProxyEditorState {
  fileName: string;
  loading: boolean;
  saving: boolean;
  error: string | null;
  originalText: string;
  rawText: string;
  json: Record<string, unknown> | null;
  prefix: string;
  proxyUrl: string;
  proxyDns: string;
}
// 标准化 auth_index 值（与 usage.ts 中的 normalizeAuthIndex 保持一致）
function normalizeAuthIndexValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function isRuntimeOnlyAuthFile(file: AuthFileItem): boolean {
  const raw = file['runtime_only'] ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

// 解析认证文件的统计数据
function resolveAuthFileStats(file: AuthFileItem, stats: KeyStats): KeyStatBucket {
  const defaultStats: KeyStatBucket = { success: 0, failure: 0 };
  const rawFileName = file?.name || '';

  // 兼容 auth_index 和 authIndex 两种字段名（API 返回的是 auth_index）
  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndexKey = normalizeAuthIndexValue(rawAuthIndex);

  // 尝试根据 authIndex 匹配
  if (authIndexKey && stats.byAuthIndex?.[authIndexKey]) {
    return stats.byAuthIndex[authIndexKey];
  }

  // 尝试根据 source (文件名) 匹配
  const fileNameId = rawFileName ? normalizeUsageSourceId(rawFileName) : '';
  if (fileNameId && stats.bySource?.[fileNameId]) {
    const fromName = stats.bySource[fileNameId];
    if (fromName.success > 0 || fromName.failure > 0) {
      return fromName;
    }
  }

  // 尝试去掉扩展名后匹配
  if (rawFileName) {
    const nameWithoutExt = rawFileName.replace(/\.[^/.]+$/, '');
    if (nameWithoutExt && nameWithoutExt !== rawFileName) {
      const nameWithoutExtId = normalizeUsageSourceId(nameWithoutExt);
      const fromNameWithoutExt = nameWithoutExtId ? stats.bySource?.[nameWithoutExtId] : undefined;
      if (
        fromNameWithoutExt &&
        (fromNameWithoutExt.success > 0 || fromNameWithoutExt.failure > 0)
      ) {
        return fromNameWithoutExt;
      }
    }
  }

  return defaultStats;
}

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | string>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(9);
  const [pageSizeInput, setPageSizeInput] = useState('9');
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<AuthFileItem | null>(null);

  // 模型列表弹窗相关
  const [modelsModalOpen, setModelsModalOpen] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsList, setModelsList] = useState<AuthFileModelItem[]>([]);
  const [modelsFileName, setModelsFileName] = useState('');
  const [modelsFileType, setModelsFileType] = useState('');
  const [modelsError, setModelsError] = useState<'unsupported' | null>(null);
  const modelsCacheRef = useRef<Map<string, AuthFileModelItem[]>>(new Map());

  // 健康检查相关
  const [healthChecking, setHealthChecking] = useState(false);
  const [singleModelChecking, setSingleModelChecking] = useState<string | null>(null); // 正在检查的单个模型 ID
  const [healthResults, setHealthResults] = useState<Record<string, {
    status: 'healthy' | 'unhealthy' | 'timeout';
    message?: string;
    latency_ms?: number;
  }>>({});
  const [healthCheckProxyUsed, setHealthCheckProxyUsed] = useState<boolean | null>(null); // 健康检查是否走了代理，null 表示未检查
  const [modelsModalItem, setModelsModalItem] = useState<AuthFileItem | null>(null); // 当前模型弹窗对应的认证文件，用于显示 proxy_url

  // OAuth 排除模型相关
  const [excluded, setExcluded] = useState<Record<string, string[]>>({});
  const [excludedError, setExcludedError] = useState<'unsupported' | null>(null);

  // OAuth 模型映射相关
  const [modelAlias, setModelAlias] = useState<Record<string, OAuthModelAliasEntry[]>>({});
  const [modelAliasError, setModelAliasError] = useState<'unsupported' | null>(null);
  const [allProviderModels, setAllProviderModels] = useState<Record<string, AuthFileModelItem[]>>(
    {}
  );
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const [batchActionBarVisible, setBatchActionBarVisible] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const previousSelectionCountRef = useRef(0);
  const selectionCountRef = useRef(0);

  const { keyStats, usageDetails, loadKeyStats, refreshKeyStats } = useAuthFilesStats();
  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    deselectAll,
    batchSetStatus,
    batchDelete
  } = useAuthFilesData({ refreshKeyStats });

  const statusBarCache = useAuthFilesStatusBarCache(files, usageDetails);

  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias
  } = useAuthFilesOauth({ viewMode, files });

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave
  } = useAuthFilesPrefixProxyEditor({
    disableControls: connectionStatus !== 'connected',
    loadFiles,
    loadKeyStats: refreshKeyStats
  });

  const disableControls = connectionStatus !== 'connected';
  const normalizedFilter = normalizeProviderKey(String(filter));
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    normalizedFilter as QuotaProviderType
  )
    ? (normalizedFilter as QuotaProviderType)
    : null;

  useEffect(() => {
    const persisted = readAuthFilesUiState();
    if (!persisted) return;

    if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
      setFilter(persisted.filter);
    }
    if (typeof persisted.search === 'string') {
      setSearch(persisted.search);
    }
    if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
      setPage(Math.max(1, Math.round(persisted.page)));
    }
    if (typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)) {
      setPageSize(clampCardPageSize(persisted.pageSize));
    }
  }, []);

  useEffect(() => {
    writeAuthFilesUiState({ filter, search, page, pageSize });
  }, [filter, search, page, pageSize]);

  useEffect(() => {
    setPageSizeInput(String(pageSize));
  }, [pageSize]);

  const prefixProxyUpdatedText = useMemo(() => {
    if (!prefixProxyEditor?.json) return prefixProxyEditor?.rawText ?? '';
    const next: Record<string, unknown> = { ...prefixProxyEditor.json };
    if ('prefix' in next || prefixProxyEditor.prefix.trim()) {
      next.prefix = prefixProxyEditor.prefix;
    }
    if ('proxy_url' in next || prefixProxyEditor.proxyUrl.trim()) {
      next.proxy_url = prefixProxyEditor.proxyUrl;
    }
    if ('proxy_dns' in next || prefixProxyEditor.proxyDns.trim()) {
      next.proxy_dns = prefixProxyEditor.proxyDns;
    }
    return JSON.stringify(next);
  }, [
    prefixProxyEditor?.json,
    prefixProxyEditor?.proxyDns,
    prefixProxyEditor?.prefix,
    prefixProxyEditor?.proxyUrl,
    prefixProxyEditor?.rawText,
  ]);

  const prefixProxyDirty = useMemo(() => {
    if (!prefixProxyEditor?.json) return false;
    if (!prefixProxyEditor.originalText) return false;
    return prefixProxyUpdatedText !== prefixProxyEditor.originalText;
  }, [prefixProxyEditor?.json, prefixProxyEditor?.originalText, prefixProxyUpdatedText]);

  const commitPageSizeInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const next = clampCardPageSize(value);
    setPageSize(next);
    setPageSizeInput(String(next));
    setPage(1);
  };

  const handlePageSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setPageSizeInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    const rounded = Math.round(parsed);
    if (rounded < MIN_CARD_PAGE_SIZE || rounded > MAX_CARD_PAGE_SIZE) return;

    setPageSize(rounded);
    setPage(1);
  };

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadFiles(), refreshKeyStats(), loadExcluded(), loadModelAlias()]);
  }, [loadFiles, refreshKeyStats, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    loadFiles();
    void loadKeyStats().catch(() => {});
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadKeyStats, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void refreshKeyStats().catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  const existingTypes = useMemo(() => {
    const types = new Set<string>(['all']);
    files.forEach((file) => {
      if (file.type) {
        types.add(file.type);
      }
    });
    return Array.from(types);
  }, [files]);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: files.length };
    files.forEach((file) => {
      if (!file.type) return;
      counts[file.type] = (counts[file.type] || 0) + 1;
    });
    return counts;
  }, [files]);

  const filtered = useMemo(() => {
    return files.filter((item) => {
      const matchType = filter === 'all' || item.type === filter;
      const term = search.trim().toLowerCase();
      const matchSearch =
        !term ||
        item.name.toLowerCase().includes(term) ||
        (item.type || '').toString().toLowerCase().includes(term) ||
        (item.provider || '').toString().toLowerCase().includes(term);
      return matchType && matchSearch;
    });
  }, [files, filter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);

  // 点击上传
  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // 处理文件上传（支持多选）
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = event.target.files;
    if (!fileList || fileList.length === 0) return;

    const filesToUpload = Array.from(fileList);
    const validFiles: File[] = [];
    const invalidFiles: string[] = [];
    const oversizedFiles: string[] = [];

    filesToUpload.forEach((file) => {
      if (!file.name.endsWith('.json')) {
        invalidFiles.push(file.name);
        return;
      }
      if (file.size > MAX_AUTH_FILE_SIZE) {
        oversizedFiles.push(file.name);
        return;
      }
      validFiles.push(file);
    });

    if (invalidFiles.length > 0) {
      showNotification(t('auth_files.upload_error_json'), 'error');
    }
    if (oversizedFiles.length > 0) {
      showNotification(
        t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
        'error'
      );
    }

    if (validFiles.length === 0) {
      event.target.value = '';
      return;
    }

    setUploading(true);
    let successCount = 0;
    const failed: { name: string; message: string }[] = [];

    for (const file of validFiles) {
      try {
        await authFilesApi.upload(file);
        successCount++;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        failed.push({ name: file.name, message: errorMessage });
      }
    }

    if (successCount > 0) {
      const suffix = validFiles.length > 1 ? ` (${successCount}/${validFiles.length})` : '';
      showNotification(
        `${t('auth_files.upload_success')}${suffix}`,
        failed.length ? 'warning' : 'success'
      );
      // 等待后端处理完成
      await new Promise((resolve) => setTimeout(resolve, 500));
      await loadFiles();
      await loadKeyStats();
      // 延迟二次刷新，确保后端 watcher 完全处理
      setTimeout(() => {
        loadFiles();
        loadKeyStats();
      }, 2000);
    }

    if (failed.length > 0) {
      const details = failed.map((item) => `${item.name}: ${item.message}`).join('; ');
      showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
    }

    setUploading(false);
    event.target.value = '';
  };

  // 删除单个文件
  const handleDelete = async (name: string) => {
    showConfirmation({
      title: t('auth_files.delete_title', { defaultValue: 'Delete File' }),
      message: `${t('auth_files.delete_confirm')} "${name}" ?`,
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        setDeleting(name);
        try {
          await authFilesApi.deleteFile(name);
          showNotification(t('auth_files.delete_success'), 'success');
          setFiles((prev) => prev.filter((item) => item.name !== name));
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : '';
          showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  // 删除全部（根据筛选类型）
  const handleDeleteAll = async () => {
    const isFiltered = filter !== 'all';
    const typeLabel = isFiltered ? getTypeLabel(filter) : t('auth_files.filter_all');
    const confirmMessage = isFiltered
      ? t('auth_files.delete_filtered_confirm', { type: typeLabel })
      : t('auth_files.delete_all_confirm');

    showConfirmation({
      title: t('auth_files.delete_all_title', { defaultValue: 'Delete All Files' }),
      message: confirmMessage,
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        setDeletingAll(true);
        try {
          if (!isFiltered) {
            // 删除全部
            await authFilesApi.deleteAll();
            showNotification(t('auth_files.delete_all_success'), 'success');
            setFiles((prev) => prev.filter((file) => isRuntimeOnlyAuthFile(file)));
          } else {
            // 删除筛选类型的文件
            const filesToDelete = files.filter(
              (f) => f.type === filter && !isRuntimeOnlyAuthFile(f)
            );

            if (filesToDelete.length === 0) {
              showNotification(t('auth_files.delete_filtered_none', { type: typeLabel }), 'info');
              setDeletingAll(false);
              return;
            }

            let success = 0;
            let failed = 0;
            const deletedNames: string[] = [];

            for (const file of filesToDelete) {
              try {
                await authFilesApi.deleteFile(file.name);
                success++;
                deletedNames.push(file.name);
              } catch {
                failed++;
              }
            }

            setFiles((prev) => prev.filter((f) => !deletedNames.includes(f.name)));

            if (failed === 0) {
              showNotification(
                t('auth_files.delete_filtered_success', { count: success, type: typeLabel }),
                'success'
              );
            } else {
              showNotification(
                t('auth_files.delete_filtered_partial', { success, failed, type: typeLabel }),
                'warning'
              );
            }
            setFilter('all');
          }
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : '';
          showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
        } finally {
          setDeletingAll(false);
        }
      },
    });
  };

  // 下载文件
  const handleDownload = async (name: string) => {
    try {
      const response = await apiClient.getRaw(
        `/auth-files/download?name=${encodeURIComponent(name)}`,
        {
          responseType: 'blob',
        }
      );
      const blob = new Blob([response.data]);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      window.URL.revokeObjectURL(url);
      showNotification(t('auth_files.download_success'), 'success');
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
    }
  };

  const openPrefixProxyEditor = async (name: string) => {
    if (disableControls) return;
    if (prefixProxyEditor?.fileName === name) {
      setPrefixProxyEditor(null);
      return;
    }

    setPrefixProxyEditor({
      fileName: name,
      loading: true,
      saving: false,
      error: null,
      originalText: '',
      rawText: '',
      json: null,
      prefix: '',
      proxyUrl: '',
      proxyDns: '',
    });

    try {
      const rawText = await authFilesApi.downloadText(name);
      const trimmed = rawText.trim();

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed) as unknown;
      } catch {
        setPrefixProxyEditor((prev) => {
          if (!prev || prev.fileName !== name) return prev;
          return {
            ...prev,
            loading: false,
            error: t('auth_files.prefix_proxy_invalid_json'),
            rawText: trimmed,
            originalText: trimmed,
          };
        });
        return;
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        setPrefixProxyEditor((prev) => {
          if (!prev || prev.fileName !== name) return prev;
          return {
            ...prev,
            loading: false,
            error: t('auth_files.prefix_proxy_invalid_json'),
            rawText: trimmed,
            originalText: trimmed,
          };
        });
        return;
      }

      const json = parsed as Record<string, unknown>;
      const originalText = JSON.stringify(json);
      const prefix = typeof json.prefix === 'string' ? json.prefix : '';
      const proxyUrl = typeof json.proxy_url === 'string' ? json.proxy_url : '';
      const proxyDns = typeof json.proxy_dns === 'string' ? json.proxy_dns : '';

      setPrefixProxyEditor((prev) => {
        if (!prev || prev.fileName !== name) return prev;
        return {
          ...prev,
          loading: false,
          originalText,
          rawText: originalText,
          json,
          prefix,
          proxyDns,
          proxyUrl,
          error: null,
        };
      });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.download_failed');
      setPrefixProxyEditor((prev) => {
        if (!prev || prev.fileName !== name) return prev;
        return { ...prev, loading: false, error: errorMessage, rawText: '' };
      });
      showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
    }
  };

  const handlePrefixProxyChange = (field: 'prefix' | 'proxyUrl' | 'proxyDns', value: string) => {
    setPrefixProxyEditor((prev) => {
      if (!prev) return prev;
      if (field === 'prefix') return { ...prev, prefix: value };
      if (field === 'proxyDns') return { ...prev, proxyDns: value };
      return { ...prev, proxyUrl: value };
    });
  };

  const handlePrefixProxySave = async () => {
    if (!prefixProxyEditor?.json) return;
    if (!prefixProxyDirty) return;

    const name = prefixProxyEditor.fileName;
    const payload = prefixProxyUpdatedText;
    const fileSize = new Blob([payload]).size;
    if (fileSize > MAX_AUTH_FILE_SIZE) {
      showNotification(
        t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
        'error'
      );
      return;
    }

    setPrefixProxyEditor((prev) => {
      if (!prev || prev.fileName !== name) return prev;
      return { ...prev, saving: true };
    });

    try {
      const file = new File([payload], name, { type: 'application/json' });
      await authFilesApi.upload(file);
      showNotification(t('auth_files.prefix_proxy_saved_success', { name }), 'success');
      await loadFiles();
      await loadKeyStats();
      setPrefixProxyEditor(null);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('notification.upload_failed')}: ${errorMessage}`, 'error');
      setPrefixProxyEditor((prev) => {
        if (!prev || prev.fileName !== name) return prev;
        return { ...prev, saving: false };
      });
    }
  };

  const handleStatusToggle = async (item: AuthFileItem, enabled: boolean) => {
    const name = item.name;
    const nextDisabled = !enabled;
    const previousDisabled = item.disabled === true;

    setStatusUpdating((prev) => ({ ...prev, [name]: true }));
    // Optimistic update for snappy UI.
    setFiles((prev) => prev.map((f) => (f.name === name ? { ...f, disabled: nextDisabled } : f)));

    try {
      const res = await authFilesApi.setStatus(name, nextDisabled);
      setFiles((prev) => prev.map((f) => (f.name === name ? { ...f, disabled: res.disabled } : f)));
      showNotification(
        enabled
          ? t('auth_files.status_enabled_success', { name })
          : t('auth_files.status_disabled_success', { name }),
        'success'
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      setFiles((prev) =>
        prev.map((f) => (f.name === name ? { ...f, disabled: previousDisabled } : f))
      );
      showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
    } finally {
      setStatusUpdating((prev) => {
        if (!prev[name]) return prev;
        const next = { ...prev };
        delete next[name];
        return next;
      });
    }
  };

  // 显示详情弹窗
  const showDetails = (file: AuthFileItem) => {
    setSelectedFile(file);
    setDetailModalOpen(true);
  };

  // 显示模型列表
  const showModels = async (item: AuthFileItem) => {
    setModelsFileName(item.name);
    setModelsFileType(item.type || '');
    setModelsModalItem(item);
    setModelsList([]);
    setModelsError(null);
    setHealthCheckProxyUsed(null);
    setModelsModalOpen(true);

    const cached = modelsCacheRef.current.get(item.name);
    if (cached) {
      setModelsList(cached);
      setModelsLoading(false);
      return;
    }

    setModelsLoading(true);
    try {
      const models = await authFilesApi.getModelsForAuthFile(item.name);
      modelsCacheRef.current.set(item.name, models);
      setModelsList(models);
    } catch (err) {
      // 检测是否是 API 不支持的错误 (404 或特定错误消息)
      const errorMessage = err instanceof Error ? err.message : '';
      if (
        errorMessage.includes('404') ||
        errorMessage.includes('not found') ||
        errorMessage.includes('Not Found')
      ) {
        setModelsError('unsupported');
      } else {
        showNotification(`${t('notification.load_failed')}: ${errorMessage}`, 'error');
      }
    } finally {
      setModelsLoading(false);
    }
  };

  // 健康检查（流式：检查完成一个返回一个，超过 30s 的显示为超时）
  const handleHealthCheck = async () => {
    if (!modelsFileName || modelsList.length === 0) {
      return;
    }

    setHealthChecking(true);
    setHealthResults({});
    setHealthCheckProxyUsed(null);
    const streamResultsRef: Array<{ status: 'healthy' | 'unhealthy' | 'timeout' }> = [];

    try {
      await authFilesApi.checkModelsHealthStream(
        modelsFileName,
        { concurrent: true, timeout: 10 },
        {
          onMeta: (meta) => {
            setHealthCheckProxyUsed(meta.proxy_used);
          },
          onResult: (item) => {
            streamResultsRef.push({ status: item.status });
            setHealthResults((prev) => ({
              ...prev,
              [item.model_id]: {
                status: item.status,
                message: item.message,
                latency_ms: item.latency_ms,
              },
            }));
          },
          onDone: () => {
            const healthy_count = streamResultsRef.filter((r) => r.status === 'healthy').length;
            const unhealthy_count = streamResultsRef.filter((r) => r.status === 'unhealthy').length;
            const timeout_count = streamResultsRef.filter((r) => r.status === 'timeout').length;

            if (unhealthy_count === 0 && timeout_count === 0 && healthy_count > 0) {
              showNotification(
                t('auth_files.health_check_all_healthy', {
                  defaultValue: '所有模型健康检查通过',
                  count: healthy_count,
                }),
                'success'
              );
            } else if (healthy_count === 0 && unhealthy_count === 0 && timeout_count > 0) {
              showNotification(
                t('auth_files.health_check_partial_with_timeout', {
                  healthy: 0,
                  unhealthy: 0,
                  timeout: timeout_count,
                }),
                'warning'
              );
            } else if (timeout_count > 0) {
              showNotification(
                t('auth_files.health_check_partial_with_timeout', {
                  healthy: healthy_count,
                  unhealthy: unhealthy_count,
                  timeout: timeout_count,
                }),
                'info'
              );
            } else if (unhealthy_count === 0) {
              showNotification(
                t('auth_files.health_check_all_healthy', {
                  defaultValue: '所有模型健康检查通过',
                  count: healthy_count,
                }),
                'success'
              );
            } else if (healthy_count === 0) {
              showNotification(
                t('auth_files.health_check_all_unhealthy', {
                  defaultValue: '所有模型健康检查失败',
                  count: unhealthy_count,
                }),
                'error'
              );
            } else {
              showNotification(
                t('auth_files.health_check_partial', {
                  defaultValue: '健康检查完成：{{healthy}} 个健康，{{unhealthy}} 个异常',
                  healthy: healthy_count,
                  unhealthy: unhealthy_count,
                }),
                'info'
              );
            }
          },
        }
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      showNotification(
        t('auth_files.health_check_failed', {
          defaultValue: '健康检查失败',
        }) + `: ${errorMessage}`,
        'error'
      );
    } finally {
      setHealthChecking(false);
    }
  };

  // 单个模型健康检查
  const handleSingleModelHealthCheck = async (modelId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // 防止触发复制操作

    if (!modelsFileName || singleModelChecking) {
      return;
    }

    setSingleModelChecking(modelId);

    try {
      const result = await authFilesApi.checkModelsHealth(modelsFileName, {
        model: modelId,
        timeout: 10,
      });

      if (result.models.length > 0) {
        const modelResult = result.models[0];
        setHealthResults((prev) => ({
          ...prev,
          [modelResult.model_id]: {
            status: modelResult.status,
            message: modelResult.message,
            latency_ms: modelResult.latency_ms,
          },
        }));
        if (typeof result.proxy_used === 'boolean') {
          setHealthCheckProxyUsed(result.proxy_used);
        }

        if (modelResult.status === 'healthy') {
          showNotification(
            `${modelId}: ${t('auth_files.health_status_healthy', { defaultValue: '健康' })}${modelResult.latency_ms ? ` (${modelResult.latency_ms}ms)` : ''}`,
            'success'
          );
        } else {
          showNotification(
            `${modelId}: ${t('auth_files.health_status_unhealthy', { defaultValue: '异常' })} - ${modelResult.message || ''}`,
            'error'
          );
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      showNotification(
        `${modelId}: ${t('auth_files.health_check_failed', { defaultValue: '健康检查失败' })} - ${errorMessage}`,
        'error'
      );
    } finally {
      setSingleModelChecking(null);
    }
  };

  // 检查模型是否被 OAuth 排除
  const isModelExcluded = (modelId: string, providerType: string): boolean => {
    const providerKey = normalizeProviderKey(providerType);
    const excludedModels = excluded[providerKey] || excluded[providerType] || [];
    return excludedModels.some((pattern) => {
      if (pattern.includes('*')) {
        // 支持通配符匹配
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$', 'i');
        return regex.test(modelId);
      }
      return pattern.toLowerCase() === modelId.toLowerCase();
    });
  };

  // 获取类型标签显示文本
  const getTypeLabel = (type: string): string => {
    const key = `auth_files.filter_${type}`;
    const translated = t(key);
    if (translated !== key) return translated;
    if (type.toLowerCase() === 'iflow') return 'iFlow';
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  // 获取类型颜色
  const getTypeColor = (type: string): ThemeColors => {
    const set = TYPE_COLORS[type] || TYPE_COLORS.unknown;
    return resolvedTheme === 'dark' && set.dark ? set.dark : set.light;
  };

  const openExcludedEditor = (provider?: string) => {
    const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
    const params = new URLSearchParams();
    if (providerValue) {
      params.set('provider', providerValue);
    }
    const search = params.toString();
    navigate(`/auth-files/oauth-excluded${search ? `?${search}` : ''}`, {
      state: { fromAuthFiles: true },
    });
  };

  const deleteExcluded = async (provider: string) => {
    const providerLabel = provider.trim() || provider;
    showConfirmation({
      title: t('oauth_excluded.delete_title', { defaultValue: 'Delete Exclusion' }),
      message: t('oauth_excluded.delete_confirm', { provider: providerLabel }),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        const providerKey = normalizeProviderKey(provider);
        if (!providerKey) {
          showNotification(t('oauth_excluded.provider_required'), 'error');
          return;
        }
        try {
          await authFilesApi.deleteOauthExcludedEntry(providerKey);
          await loadExcluded();
          showNotification(t('oauth_excluded.delete_success'), 'success');
        } catch (err: unknown) {
          try {
            const current = await authFilesApi.getOauthExcludedModels();
            const next: Record<string, string[]> = {};
            Object.entries(current).forEach(([key, models]) => {
              if (normalizeProviderKey(key) === providerKey) return;
              next[key] = models;
            });
            await authFilesApi.replaceOauthExcludedModels(next);
            await loadExcluded();
            showNotification(t('oauth_excluded.delete_success'), 'success');
          } catch (fallbackErr: unknown) {
            const errorMessage =
              fallbackErr instanceof Error
                ? fallbackErr.message
                : err instanceof Error
                  ? err.message
                  : '';
            showNotification(`${t('oauth_excluded.delete_failed')}: ${errorMessage}`, 'error');
          }
        }
      },
    });
  };

  const openModelAliasEditor = (provider?: string) => {
    const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
    const params = new URLSearchParams();
    if (providerValue) {
      params.set('provider', providerValue);
    }
    const search = params.toString();
    navigate(`/auth-files/oauth-model-alias${search ? `?${search}` : ''}`, {
      state: { fromAuthFiles: true },
    });
  };

  const deleteModelAlias = async (provider: string) => {
    showConfirmation({
      title: t('oauth_model_alias.delete_title', { defaultValue: 'Delete Mappings' }),
      message: t('oauth_model_alias.delete_confirm', { provider }),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await authFilesApi.deleteOauthModelAlias(provider);
          await loadModelAlias();
          showNotification(t('oauth_model_alias.delete_success'), 'success');
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : '';
          showNotification(`${t('oauth_model_alias.delete_failed')}: ${errorMessage}`, 'error');
        }
      },
    });
  };

  const handleMappingUpdate = async (provider: string, sourceModel: string, newAlias: string) => {
    if (!provider || !sourceModel || !newAlias) return;
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider) return;

    const providerKey = Object.keys(modelAlias).find(
      (key) => normalizeProviderKey(key) === normalizedProvider
    );
    const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];

    const nameTrim = sourceModel.trim();
    const aliasTrim = newAlias.trim();
    const nameKey = nameTrim.toLowerCase();
    const aliasKey = aliasTrim.toLowerCase();

    if (
      currentMappings.some(
        (m) =>
          (m.name ?? '').trim().toLowerCase() === nameKey &&
          (m.alias ?? '').trim().toLowerCase() === aliasKey
      )
    ) {
      return;
    }

    const nextMappings: OAuthModelAliasEntry[] = [
      ...currentMappings,
      { name: nameTrim, alias: aliasTrim, fork: true },
    ];

    try {
      await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
      await loadModelAlias();
      showNotification(t('oauth_model_alias.save_success'), 'success');
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
    }
  };

  const handleDeleteLink = (provider: string, sourceModel: string, alias: string) => {
    const nameTrim = sourceModel.trim();
    const aliasTrim = alias.trim();
    if (!provider || !nameTrim || !aliasTrim) return;

    showConfirmation({
      title: t('oauth_model_alias.delete_link_title', { defaultValue: 'Unlink mapping' }),
      message: (
        <Trans
          i18nKey="oauth_model_alias.delete_link_confirm"
          values={{ provider, sourceModel: nameTrim, alias: aliasTrim }}
          components={{ code: <code /> }}
        />
      ),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        const normalizedProvider = normalizeProviderKey(provider);
        const providerKey = Object.keys(modelAlias).find(
          (key) => normalizeProviderKey(key) === normalizedProvider
        );
        const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];
        const nameKey = nameTrim.toLowerCase();
        const aliasKey = aliasTrim.toLowerCase();
        const nextMappings = currentMappings.filter(
          (m) =>
            (m.name ?? '').trim().toLowerCase() !== nameKey ||
            (m.alias ?? '').trim().toLowerCase() !== aliasKey
        );
        if (nextMappings.length === currentMappings.length) return;

        try {
          if (nextMappings.length === 0) {
            await authFilesApi.deleteOauthModelAlias(normalizedProvider);
          } else {
            await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
          }
          await loadModelAlias();
          showNotification(t('oauth_model_alias.save_success'), 'success');
        } catch (err: unknown) {
          const errorMessage = err instanceof Error ? err.message : '';
          showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
        }
      },
    });
  };

  const handleToggleFork = async (
    provider: string,
    sourceModel: string,
    alias: string,
    fork: boolean
  ) => {
    const normalizedProvider = normalizeProviderKey(provider);
    if (!normalizedProvider) return;

    const providerKey = Object.keys(modelAlias).find(
      (key) => normalizeProviderKey(key) === normalizedProvider
    );
    const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];
    const nameKey = sourceModel.trim().toLowerCase();
    const aliasKey = alias.trim().toLowerCase();
    let changed = false;

    const nextMappings = currentMappings.map((m) => {
      const mName = (m.name ?? '').trim().toLowerCase();
      const mAlias = (m.alias ?? '').trim().toLowerCase();
      if (mName === nameKey && mAlias === aliasKey) {
        changed = true;
        return fork ? { ...m, fork: true } : { name: m.name, alias: m.alias };
      }
      return m;
    });

    if (!changed) return;

    try {
      await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
      await loadModelAlias();
      showNotification(t('oauth_model_alias.save_success'), 'success');
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
    }
  };

  const handleRenameAlias = async (oldAlias: string, newAlias: string) => {
    const oldTrim = oldAlias.trim();
    const newTrim = newAlias.trim();
    if (!oldTrim || !newTrim || oldTrim === newTrim) return;

    const oldKey = oldTrim.toLowerCase();
    const providersToUpdate = Object.entries(modelAlias).filter(([_, mappings]) =>
      mappings.some((m) => (m.alias ?? '').trim().toLowerCase() === oldKey)
    );

    if (providersToUpdate.length === 0) return;

    let hadFailure = false;
    let failureMessage = '';

    try {
      const results = await Promise.allSettled(
        providersToUpdate.map(([provider, mappings]) => {
          const nextMappings = mappings.map((m) =>
            (m.alias ?? '').trim().toLowerCase() === oldKey ? { ...m, alias: newTrim } : m
          );
          return authFilesApi.saveOauthModelAlias(provider, nextMappings);
        })
      );

      const failures = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      );

      if (failures.length > 0) {
        hadFailure = true;
        const reason = failures[0].reason;
        failureMessage = reason instanceof Error ? reason.message : String(reason ?? '');
      }
    } finally {
      await loadModelAlias();
    }

    if (hadFailure) {
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const openExcludedEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-excluded${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true }
      });
    },
    [filter, navigate]
  );

  const openModelAliasEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-model-alias${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true }
      });
    },
    [filter, navigate]
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) {
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
      return;
    }

    const updatePadding = () => {
      const height = actionsEl.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--auth-files-action-bar-height', `${height}px`);
    };

    updatePadding();
    window.addEventListener('resize', updatePadding);

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePadding);
    ro?.observe(actionsEl);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePadding);
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
    };
  }, [batchActionBarVisible, selectionCount]);

  useEffect(() => {
    selectionCountRef.current = selectionCount;
    if (selectionCount > 0) {
      setBatchActionBarVisible(true);
    }
  }, [selectionCount]);

  useLayoutEffect(() => {
    if (!batchActionBarVisible) return;
    const currentCount = selectionCount;
    const previousCount = previousSelectionCountRef.current;
    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) return;

    gsap.killTweensOf(actionsEl);

    if (currentCount > 0 && previousCount === 0) {
      gsap.fromTo(
        actionsEl,
        { y: 56, autoAlpha: 0 },
        { y: 0, autoAlpha: 1, duration: 0.28, ease: 'power3.out' }
      );
    } else if (currentCount === 0 && previousCount > 0) {
      gsap.to(actionsEl, {
        y: 56,
        autoAlpha: 0,
        duration: 0.22,
        ease: 'power2.in',
        onComplete: () => {
          if (selectionCountRef.current === 0) {
            setBatchActionBarVisible(false);
          }
        }
      });
    }

    previousSelectionCountRef.current = currentCount;
  }, [batchActionBarVisible, selectionCount]);

  const renderFilterTags = () => (
    <div className={styles.filterTags}>
      {existingTypes.map((type) => {
        const isActive = filter === type;
        const color =
          type === 'all'
            ? { bg: 'var(--bg-tertiary)', text: 'var(--text-primary)' }
            : getTypeColor(type, resolvedTheme);
        const activeTextColor = resolvedTheme === 'dark' ? '#111827' : '#fff';
        return (
          <button
            key={type}
            className={`${styles.filterTag} ${isActive ? styles.filterTagActive : ''}`}
            style={{
              backgroundColor: isActive ? color.text : color.bg,
              color: isActive ? activeTextColor : color.text,
              borderColor: color.text
            }}
            onClick={() => {
              setFilter(type);
              setPage(1);
            }}
          >
            <span className={styles.filterTagLabel}>{getTypeLabel(t, type)}</span>
            <span className={styles.filterTagCount}>{typeCounts[type] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t('auth_files.title_section')}</span>
      {files.length > 0 && <span className={styles.countBadge}>{files.length}</span>}
    </div>
  );

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('auth_files.title')}</h1>
        <p className={styles.description}>{t('auth_files.description')}</p>
      </div>

      <Card
        title={titleNode}
        extra={
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleHeaderRefresh} disabled={loading}>
              {t('common.refresh')}
            </Button>
            <Button
              size="sm"
              onClick={handleUploadClick}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              {t('auth_files.upload_button')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => handleDeleteAll({ filter, onResetFilterToAll: () => setFilter('all') })}
              disabled={disableControls || loading || deletingAll}
              loading={deletingAll}
            >
              {filter === 'all'
                ? t('auth_files.delete_all_button')
                : `${t('common.delete')} ${getTypeLabel(t, filter)}`}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        }
      >
        {error && <div className={styles.errorBox}>{error}</div>}

        <div className={styles.filterSection}>
          {renderFilterTags()}

          <div className={styles.filterControls}>
            <div className={styles.filterItem}>
              <label>{t('auth_files.search_label')}</label>
              <Input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder={t('auth_files.search_placeholder')}
              />
            </div>
            <div className={styles.filterItem}>
              <label>{t('auth_files.page_size_label')}</label>
              <input
                className={styles.pageSizeSelect}
                type="number"
                min={MIN_CARD_PAGE_SIZE}
                max={MAX_CARD_PAGE_SIZE}
                step={1}
                value={pageSizeInput}
                onChange={handlePageSizeChange}
                onBlur={(e) => commitPageSizeInput(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.currentTarget.blur();
                  }
                }}
              />
            </div>
          </div>
        </div>

        {loading ? (
          <div className={styles.hint}>{t('common.loading')}</div>
        ) : pageItems.length === 0 ? (
          <EmptyState title={t('auth_files.search_empty_title')} description={t('auth_files.search_empty_desc')} />
        ) : (
          <div className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''}`}>
            {pageItems.map((file) => (
              <AuthFileCard
                key={file.name}
                file={file}
                selected={selectedFiles.has(file.name)}
                resolvedTheme={resolvedTheme}
                disableControls={disableControls}
                deleting={deleting}
                statusUpdating={statusUpdating}
                quotaFilterType={quotaFilterType}
                keyStats={keyStats}
                statusBarCache={statusBarCache}
                onShowModels={showModels}
                onShowDetails={showDetails}
                onDownload={handleDownload}
                onOpenPrefixProxyEditor={openPrefixProxyEditor}
                onDelete={handleDelete}
                onToggleStatus={handleStatusToggle}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>
        )}

        {!loading && filtered.length > pageSize && (
          <div className={styles.pagination}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              disabled={currentPage <= 1}
            >
              {t('auth_files.pagination_prev')}
            </Button>
            <div className={styles.pageInfo}>
              {t('auth_files.pagination_info', {
                current: currentPage,
                total: totalPages,
                count: filtered.length
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage >= totalPages}
            >
              {t('auth_files.pagination_next')}
            </Button>
          </div>
        )}
      </Card>

      <OAuthExcludedCard
        disableControls={disableControls}
        excludedError={excludedError}
        excluded={excluded}
        onAdd={() => openExcludedEditor()}
        onEdit={openExcludedEditor}
        onDelete={deleteExcluded}
      />

      <OAuthModelAliasCard
        disableControls={disableControls}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAdd={() => openModelAliasEditor()}
        onEditProvider={openModelAliasEditor}
        onDeleteProvider={deleteModelAlias}
        modelAliasError={modelAliasError}
        modelAlias={modelAlias}
        allProviderModels={allProviderModels}
        onUpdate={handleMappingUpdate}
        onDeleteLink={handleDeleteLink}
        onToggleFork={handleToggleFork}
        onRenameAlias={handleRenameAlias}
        onDeleteAlias={handleDeleteAlias}
      />

      <AuthFileDetailModal
        open={detailModalOpen}
        file={selectedFile}
        onClose={() => setDetailModalOpen(false)}
        onCopyText={copyTextWithNotification}
      />

      <AuthFileModelsModal
        open={modelsModalOpen}
        onClose={() => {
          setModelsModalOpen(false);
          setHealthResults({});
          setHealthCheckProxyUsed(null);
          setModelsModalItem(null);
        }}
        title={
          t('auth_files.models_title', { defaultValue: '支持的模型' }) + ` - ${modelsFileName}`
        }
        footer={
          <>
            <div className={styles.modelsModalFooterLeft}>
              <span
                className={styles.proxyUrlText}
                title={modelsModalItem?.proxy_url ?? modelsModalItem?.['proxy_url'] ?? ''}
              >
                {(modelsModalItem?.proxy_url ?? modelsModalItem?.['proxy_url'] ?? '').trim()
                  ? (() => {
                      const url = String((modelsModalItem?.proxy_url ?? modelsModalItem?.['proxy_url']) ?? '');
                      return url.length > 40 ? `${url.slice(0, 40)}…` : url;
                    })()
                  : t('auth_files.proxy_not_configured', { defaultValue: '未配置代理' })}
              </span>
              {healthCheckProxyUsed !== null && (
                <span
                  className={
                    healthCheckProxyUsed ? styles.proxyDotUsed : styles.proxyDotUnused
                  }
                  title={
                    healthCheckProxyUsed
                      ? t('auth_files.proxy_used_tooltip', { defaultValue: '代理：已使用' })
                      : t('auth_files.proxy_not_used_tooltip', { defaultValue: '代理：未使用' })
                  }
                />
              )}
            </div>
            <Button
              variant="secondary"
              onClick={handleHealthCheck}
              loading={healthChecking}
              disabled={modelsLoading || modelsList.length === 0 || healthChecking}
            >
              {t('auth_files.health_check_button', { defaultValue: '健康检查' })}
            </Button>
            <Button variant="secondary" onClick={() => {
              setModelsModalOpen(false);
              setHealthResults({});
              setHealthCheckProxyUsed(null);
              setModelsModalItem(null);
            }}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        {modelsLoading ? (
          <div className={styles.hint}>
            {t('auth_files.models_loading', { defaultValue: '正在加载模型列表...' })}
          </div>
        ) : modelsError === 'unsupported' ? (
          <EmptyState
            title={t('auth_files.models_unsupported', { defaultValue: '当前版本不支持此功能' })}
            description={t('auth_files.models_unsupported_desc', {
              defaultValue: '请更新 CLI Proxy API 到最新版本后重试',
            })}
          />
        ) : modelsList.length === 0 ? (
          <EmptyState
            title={t('auth_files.models_empty', { defaultValue: '该凭证暂无可用模型' })}
            description={t('auth_files.models_empty_desc', {
              defaultValue: '该认证凭证可能尚未被服务器加载或没有绑定任何模型',
            })}
          />
        ) : (
          <div className={styles.modelsList}>
            {modelsList.map((model) => {
              const isExcluded = isModelExcluded(model.id, modelsFileType);
              const healthResult = healthResults[model.id];
              const hasHealthResult = healthResult !== undefined;
              const isCheckingThis = singleModelChecking === model.id;
              return (
                <div
                  key={model.id}
                  className={`${styles.modelItem} ${isExcluded ? styles.modelItemExcluded : ''} ${
                    hasHealthResult
                      ? healthResult.status === 'healthy'
                        ? styles.modelItemHealthy
                        : healthResult.status === 'timeout'
                          ? styles.modelItemTimeout
                          : styles.modelItemUnhealthy
                      : ''
                  }`}
                  onClick={() => {
                    navigator.clipboard.writeText(model.id);
                    showNotification(
                      t('notification.link_copied', { defaultValue: '已复制到剪贴板' }),
                      'success'
                    );
                  }}
                  title={
                    isExcluded
                      ? t('auth_files.models_excluded_hint', {
                          defaultValue: '此模型已被 OAuth 排除',
                        })
                      : hasHealthResult
                        ? healthResult.status === 'healthy'
                          ? `${t('auth_files.health_status_healthy', { defaultValue: '健康' })}${healthResult.latency_ms ? ` (${healthResult.latency_ms}ms)` : ''}`
                          : healthResult.status === 'timeout'
                            ? t('auth_files.health_status_timeout', { defaultValue: '超时' })
                            : `${t('auth_files.health_status_unhealthy', { defaultValue: '异常' })}: ${healthResult.message || ''}`
                        : t('common.copy', { defaultValue: '点击复制' })
                  }
                >
                  <div className={styles.modelInfo}>
                    <span className={styles.modelId}>{model.id}</span>
                    {model.display_name && model.display_name !== model.id && (
                      <span className={styles.modelDisplayName}>{model.display_name}</span>
                    )}
                    {model.type && <span className={styles.modelType}>{model.type}</span>}
                    {isExcluded && (
                      <span className={styles.modelExcludedBadge}>
                        {t('auth_files.models_excluded_badge', { defaultValue: '已排除' })}
                      </span>
                    )}
                    {hasHealthResult && (
                      <span
                        className={
                          healthResult.status === 'healthy'
                            ? styles.modelHealthBadge
                            : healthResult.status === 'timeout'
                              ? styles.modelHealthBadgeTimeout
                              : styles.modelHealthBadgeUnhealthy
                        }
                      >
                        {healthResult.status === 'healthy' ? (
                          <>
                            {t('auth_files.health_status_healthy', { defaultValue: '健康' })}
                            {healthResult.latency_ms && ` (${healthResult.latency_ms}ms)`}
                          </>
                        ) : healthResult.status === 'timeout' ? (
                          t('auth_files.health_status_timeout', { defaultValue: '超时' })
                        ) : (
                          t('auth_files.health_status_unhealthy', { defaultValue: '异常' })
                        )}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    className={styles.modelCheckButton}
                    onClick={(e) => void handleSingleModelHealthCheck(model.id, e)}
                    disabled={healthChecking || singleModelChecking !== null}
                    title={t('auth_files.health_check_single', { defaultValue: '检查此模型' })}
                  >
                    {isCheckingThis ? (
                      <LoadingSpinner size={14} />
                    ) : (
                      <span className={styles.checkIcon}>✓</span>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {t('auth_files.batch_selected', { count: selectionCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_select_all')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAll}>
                    {t('auth_files.batch_deselect')}
                  </Button>
                </div>
                <div className={styles.batchActionRight}>
                  <Button
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, true)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('auth_files.batch_enable')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, false)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('auth_files.batch_disable')}
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => batchDelete(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                {prefixProxyEditor.error && (
                  <div className={styles.prefixProxyError}>{prefixProxyEditor.error}</div>
                )}
                <div className={styles.prefixProxyJsonWrapper}>
                  <label className={styles.prefixProxyLabel}>
                    {t('auth_files.prefix_proxy_source_label')}
                  </label>
                  <textarea
                    className={styles.prefixProxyTextarea}
                    rows={10}
                    readOnly
                    value={prefixProxyUpdatedText}
                  />
                </div>
                <div className={styles.prefixProxyFields}>
                  <Input
                    label={t('auth_files.prefix_label')}
                    value={prefixProxyEditor.prefix}
                    disabled={
                      disableControls || prefixProxyEditor.saving || !prefixProxyEditor.json
                    }
                    onChange={(e) => handlePrefixProxyChange('prefix', e.target.value)}
                  />
                  <Input
                    label={t('auth_files.proxy_url_label')}
                    value={prefixProxyEditor.proxyUrl}
                    placeholder={t('auth_files.proxy_url_placeholder')}
                    disabled={
                      disableControls || prefixProxyEditor.saving || !prefixProxyEditor.json
                    }
                    onChange={(e) => handlePrefixProxyChange('proxyUrl', e.target.value)}
                  />
                  <Input
                    label={t('common.proxy_dns_label')}
                    value={prefixProxyEditor.proxyDns}
                    placeholder={t('common.proxy_dns_placeholder')}
                    disabled={
                      disableControls || prefixProxyEditor.saving || !prefixProxyEditor.json
                    }
                    onChange={(e) => handlePrefixProxyChange('proxyDns', e.target.value)}
                    hint={t('common.proxy_dns_hint')}
                  />
                </div>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
