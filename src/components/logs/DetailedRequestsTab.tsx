/**
 * DetailedRequestsTab - 请求详情标签页
 * 展示完整的请求/响应详情，包括重试追踪、Header 查看、cURL 导出等功能。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { useNotificationStore } from '@/stores';
import { detailedRequestsApi } from '@/services/api/detailedRequests';
import type {
  DetailedRequestRecord,
  DetailedRequestSummary,
  DetailedAttempt,
  DetailedRequestsQuery,
  RecordOrCached,
} from '@/services/api/detailedRequests';
import styles from './DetailedRequestsTab.module.scss';

const PAGE_SIZE = 20;
const AUTO_REFRESH_INTERVAL = 2000;

interface Props {
  disabled?: boolean;
  /** When true, the card list grows naturally and the page scrolls.
   *  When false (default/embedded), the card list has a fixed height and scrolls within. */
  fullPage?: boolean;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function inferRequestFormat(url: string): string | null {
  if (!url) return null;
  if (url.includes('/v1/responses')) return 'openai-response';
  if (url.includes('/v1/chat/completions') || url.includes('/v1/completions')) return 'openai';
  if (url.includes('/v1/messages')) return 'claude';
  if (url.includes('/v1beta/models/')) return 'gemini';
  if (url.includes('/v1internal')) return 'gemini-cli';
  return null;
}

function statusClass(code: number): string {
  if (code >= 500) return styles.status5xx;
  if (code >= 400) return styles.status4xx;
  if (code >= 300) return styles.status3xx;
  if (code >= 200) return styles.status2xx;
  return styles.status0;
}

function fmtTime(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function fmtDate(ts: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString('zh-CN');
}

function formatJson(s: string): string {
  if (!s) return '';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function headerCount(headers?: Record<string, string[]>): number {
  if (!headers) return 0;
  let count = 0;
  for (const key of Object.keys(headers)) count += headers[key].length;
  return count;
}

function toLocalISO(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function isSSEBody(body: string): boolean {
  if (!body) return false;
  return body.trimStart().startsWith('data:') || /^event:\s/m.test(body);
}

function parseSSEAssembled(raw: string): string {
  const lines = raw.split('\n');
  const textParts: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '[DONE]' || !data) continue;
    try {
      const obj = JSON.parse(data);
      // OpenAI Chat Completions streaming
      if (obj.choices) {
        for (const c of obj.choices) {
          if (c.delta?.content) textParts.push(c.delta.content);
          if (c.delta?.reasoning_content) textParts.push(c.delta.reasoning_content);
          if (c.text) textParts.push(c.text);
        }
      }
      // OpenAI Responses API streaming
      if (obj.type === 'response.output_text.delta' && typeof obj.delta === 'string') {
        textParts.push(obj.delta);
      }
      if (obj.type === 'response.reasoning.delta' && typeof obj.delta === 'string') {
        textParts.push(obj.delta);
      }
      // Anthropic streaming
      if (obj.type === 'content_block_delta' && obj.delta?.text) {
        textParts.push(obj.delta.text);
      }
      if (obj.type === 'content_block_delta' && obj.delta?.thinking) {
        textParts.push(obj.delta.thinking);
      }
    } catch {
      textParts.push(data);
    }
  }
  return textParts.join('');
}

function downloadText(content: string, filename: string, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                      */
/* ------------------------------------------------------------------ */

function HeadersView({
  headers,
  defaultOpen = false,
}: {
  headers: Record<string, string[]>;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const count = headerCount(headers);
  const keys = Object.keys(headers).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  return (
    <div>
      <div className={styles.headersToggle} onClick={() => setOpen(!open)}>
        <span className={`${styles.headersArrow} ${open ? styles.headersArrowOpen : ''}`}>&#9654;</span>
        {' '}Headers <span style={{ color: 'var(--text-secondary)', fontSize: '11px', marginLeft: 4 }}>({count})</span>
      </div>
      <div className={`${styles.headersList} ${open ? styles.headersListOpen : ''}`}>
        {keys.map((key) =>
          headers[key].map((val, i) => (
            <div key={`${key}-${i}`} className={styles.headerLine}>
              <span className={styles.headerKey}>{key}</span>
              <span className={styles.headerSep}>: </span>
              <span className={styles.headerVal}>{val}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function DataBlock({
  title,
  headers,
  body,
  titleClass,
  defaultOpen = false,
  downloadPrefix,
}: {
  title: React.ReactNode;
  headers?: Record<string, string[]>;
  body?: string;
  titleClass?: string;
  defaultOpen?: boolean;
  downloadPrefix?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const [showAssembled, setShowAssembled] = useState(false);
  const hasHeaders = headers && Object.keys(headers).length > 0;
  const hasBody = body && body !== '{}' && body !== '""';
  if (!hasHeaders && !hasBody) return null;

  const formattedBody = hasBody ? formatJson(body!) : '';
  const sse = hasBody && isSSEBody(body!);
  const assembled = sse ? parseSSEAssembled(body!) : '';
  const prefix = downloadPrefix || 'body';

  const handleDownloadBody = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasBody) return;
    const isJson = body!.trimStart().startsWith('{') || body!.trimStart().startsWith('[');
    downloadText(formattedBody, `${prefix}.${isJson ? 'json' : 'txt'}`, isJson ? 'application/json' : 'text/plain');
  };

  const handleDownloadSSE = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasBody) return;
    downloadText(body!, `${prefix}-sse.txt`);
  };

  const handleDownloadAssembled = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!assembled) return;
    downloadText(assembled, `${prefix}-content.txt`);
  };

  return (
    <div className={styles.block}>
      <div
        className={`${styles.blockTitle} ${titleClass || ''}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`${styles.blockArrow} ${open ? styles.blockArrowOpen : ''}`}>&#9654;</span>
        {title}
        {hasBody && (
          <span className={styles.blockActions} onClick={(e) => e.stopPropagation()}>
            {sse ? (
              <>
                <button
                  type="button"
                  className={styles.blockDlBtn}
                  onClick={handleDownloadSSE}
                  title={t('detailed_requests.download_sse', { defaultValue: '下载 SSE 原文' })}
                >
                  ↓SSE
                </button>
                <button
                  type="button"
                  className={styles.blockDlBtn}
                  onClick={handleDownloadAssembled}
                  title={t('detailed_requests.download_content', { defaultValue: '下载实际内容' })}
                >
                  ↓{t('detailed_requests.content_label', { defaultValue: '内容' })}
                </button>
              </>
            ) : (
              <button
                type="button"
                className={styles.blockDlBtn}
                onClick={handleDownloadBody}
                title={t('detailed_requests.download_body', { defaultValue: '下载 Body' })}
              >
                ↓
              </button>
            )}
          </span>
        )}
      </div>
      <div className={`${styles.blockContent} ${open ? styles.blockContentOpen : ''}`}>
        {hasHeaders && <HeadersView headers={headers!} />}
        {sse && open && (
          <div className={styles.sseToggleBar}>
            <button
              type="button"
              className={`${styles.sseTabBtn} ${!showAssembled ? styles.sseTabActive : ''}`}
              onClick={() => setShowAssembled(false)}
            >
              SSE
            </button>
            <button
              type="button"
              className={`${styles.sseTabBtn} ${showAssembled ? styles.sseTabActive : ''}`}
              onClick={() => setShowAssembled(true)}
            >
              {t('detailed_requests.assembled_content', { defaultValue: '实际内容' })}
            </button>
          </div>
        )}
        {hasBody && (
          <div className={styles.bodyContent}>
            {sse && showAssembled ? (assembled || '(empty)') : formattedBody}
          </div>
        )}
      </div>
    </div>
  );
}

/** 简化 Auth 字符串：从 "provider=antigravity, auth_id=xxx, label=yyy, type=oauth" 提取关键信息 */
function summarizeAuth(auth: string): string {
  const parts: Record<string, string> = {};
  for (const segment of auth.split(',')) {
    const [k, ...v] = segment.split('=');
    if (k && v.length) parts[k.trim()] = v.join('=').trim();
  }
  const provider = parts['provider'] || '';
  const label = parts['label'] || '';
  const type = parts['type'] || '';
  const pieces = [provider, label || type].filter(Boolean);
  return pieces.length > 0 ? pieces.join(' · ') : auth;
}

function AttemptRequestBlock({ attempt, attemptIndex }: { attempt: DetailedAttempt; attemptIndex: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasHeaders = attempt.request_headers && Object.keys(attempt.request_headers).length > 0;
  const hasBody = attempt.request_body && attempt.request_body !== '{}' && attempt.request_body !== '""' && attempt.request_body !== '<empty>';
  if (!hasHeaders && !hasBody && !attempt.upstream_url) return null;

  const formattedBody = hasBody ? formatJson(attempt.request_body!) : '';

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasBody) return;
    const isJson = attempt.request_body!.trimStart().startsWith('{') || attempt.request_body!.trimStart().startsWith('[');
    downloadText(formattedBody, `attempt-${attemptIndex}-request.${isJson ? 'json' : 'txt'}`, isJson ? 'application/json' : 'text/plain');
  };

  return (
    <div className={styles.retryItemBlock}>
      <div className={styles.blockTitle} onClick={() => setOpen(!open)}>
        <span className={`${styles.blockArrow} ${open ? styles.blockArrowOpen : ''}`}>&#9654;</span>
        {t('detailed_requests.upstream_request', { defaultValue: '实际请求' })}
        {attempt.method && (
          <span className={styles.inlineMethodBadge}>{attempt.method}</span>
        )}
        {attempt.upstream_url && (
          <span className={styles.inlineUrl} title={attempt.upstream_url}>{attempt.upstream_url}</span>
        )}
        <span className={styles.headerSpacer} aria-hidden />
        {attempt.auth && (
          <span className={styles.apiKeyTag} title={attempt.auth}>{summarizeAuth(attempt.auth)}</span>
        )}
        {hasBody && (
          <span className={styles.blockActions} onClick={(e) => e.stopPropagation()}>
            <button type="button" className={styles.blockDlBtn} onClick={handleDownload} title={t('detailed_requests.download_body', { defaultValue: '下载 Body' })}>
              ↓
            </button>
          </span>
        )}
      </div>
      <div className={`${styles.blockContent} ${open ? styles.blockContentOpen : ''}`}>
        {hasHeaders && <HeadersView headers={attempt.request_headers!} />}
        {hasBody && <div className={styles.bodyContent}>{formattedBody}</div>}
      </div>
    </div>
  );
}

/** 根据状态码返回对应的 CSS class */
function inlineStatusClass(code: number): string {
  if (code >= 500) return styles.status5xx;
  if (code >= 400) return styles.status4xx;
  if (code >= 300) return styles.status3xx;
  if (code >= 200) return styles.status2xx;
  return styles.status0;
}

function AttemptResponseBlock({
  attempt,
  attemptIndex,
}: {
  attempt: DetailedAttempt;
  attemptIndex: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const headers = attempt.response_headers;
  const body = attempt.response_body;
  const hasBody = body && body !== '{}' && body !== '""' && body !== '<empty>';
  const displayIndex = attempt.index ?? attemptIndex;
  const sse = hasBody && isSSEBody(body!);
  const formattedBody = hasBody ? formatJson(body!) : '';

  const handleDownloadBody = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!hasBody) return;
    if (sse) {
      downloadText(body!, `attempt-${displayIndex}-response-sse.txt`);
    } else {
      const isJson = body!.trimStart().startsWith('{') || body!.trimStart().startsWith('[');
      downloadText(formattedBody, `attempt-${displayIndex}-response.${isJson ? 'json' : 'txt'}`, isJson ? 'application/json' : 'text/plain');
    }
  };

  return (
    <div className={styles.retryItemBlock}>
      <div className={styles.blockTitle} onClick={() => setOpen(!open)}>
        <span className={`${styles.blockArrow} ${open ? styles.blockArrowOpen : ''}`}>&#9654;</span>
        {t('detailed_requests.upstream_response', { defaultValue: '上游响应' })}
        {attempt.status_code != null && (
          <span className={`${styles.inlineStatusBadge} ${inlineStatusClass(attempt.status_code)}`}>
            {attempt.status_code}
          </span>
        )}
        <span className={styles.inlineTag}>
          {t('detailed_requests.attempt_label', { defaultValue: '尝试' })} #{displayIndex}
        </span>
        {attempt.error && !attempt.status_code && (
          <span style={{ color: 'var(--error-color)', fontSize: 11 }}>Error</span>
        )}
        {hasBody && (
          <span className={styles.blockActions} onClick={(e) => e.stopPropagation()}>
            <button type="button" className={styles.blockDlBtn} onClick={handleDownloadBody} title={sse ? t('detailed_requests.download_sse', { defaultValue: '下载 SSE 原文' }) : t('detailed_requests.download_body', { defaultValue: '下载 Body' })}>
              {sse ? '↓SSE' : '↓'}
            </button>
          </span>
        )}
      </div>
      <div className={`${styles.blockContent} ${open ? styles.blockContentOpen : ''}`}>
        <HeadersView headers={headers || {}} />
        {hasBody && (
          <div className={styles.bodyContent}>{formattedBody}</div>
        )}
        {attempt.error && (
          <div className={styles.attemptError}>Error: {attempt.error}</div>
        )}
        {open && !hasBody && !attempt.error && (
          <div className={styles.bodyContent} style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
            {t('detailed_requests.no_content', { defaultValue: '无内容' })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 内部处理过程列表：展示所有尝试的请求+响应。
 * 对于请求部分：首次始终展示；后续仅当 URL/Auth/Body 不同时才展示（避免重复）。
 * 对于响应部分：每次尝试都展示。
 */
function ProcessingDetailsList({ attempts }: { attempts: DetailedAttempt[] }) {
  if (attempts.length === 0) return null;
  return (
    <>
      {attempts.map((attempt, i) => {
        const displayIndex = attempt.index ?? i + 1;
        const prev = i > 0 ? attempts[i - 1] : null;
        const showRequest =
          i === 0 ||
          attempt.upstream_url !== prev?.upstream_url ||
          attempt.auth !== prev?.auth ||
          attempt.request_body !== prev?.request_body;
        // New group starts when a new request block is shown (different target/config)
        const isNewGroup = showRequest && i > 0;
        return (
          <div
            key={`attempt-${displayIndex}-${i}`}
            className={`${styles.attemptGroup} ${isNewGroup ? styles.attemptGroupNew : ''}`}
          >
            {showRequest && <AttemptRequestBlock attempt={attempt} attemptIndex={displayIndex} />}
            <AttemptResponseBlock attempt={attempt} attemptIndex={displayIndex} />
          </div>
        );
      })}
    </>
  );
}

function RecordCard({
  summary,
  onCopyCurl,
  showRetriesBlock,
}: {
  summary: DetailedRequestSummary;
  onCopyCurl: (id: string) => void;
  showRetriesBlock: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [fullRecord, setFullRecord] = useState<DetailedRequestRecord | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [retriesBlockOpen, setRetriesBlockOpen] = useState(false);

  const fetchRecordIfNeeded = useCallback(async (): Promise<DetailedRequestRecord | null> => {
    if (fullRecord) return fullRecord;
    setLoadingDetail(true);
    try {
      const data = await detailedRequestsApi.getRecord(summary.id);
      setFullRecord(data.record);
      return data.record;
    } catch {
      return null;
    } finally {
      setLoadingDetail(false);
    }
  }, [fullRecord, summary.id]);

  const handleToggleExpand = async () => {
    const willExpand = !expanded;
    setExpanded(willExpand);
    if (willExpand && !fullRecord) {
      await fetchRecordIfNeeded();
    }
  };

  const handleDownloadRecord = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const rec = fullRecord || await fetchRecordIfNeeded();
    if (rec) {
      downloadText(JSON.stringify(rec, null, 2), `${rec.id}-full.json`, 'application/json');
    }
  };

  const hasAttempts = summary.attempt_count > 0;
  const record = fullRecord;
  const attempts = record?.attempts || [];
  const uniqueTargetCount = attempts.length > 0
    ? new Set(attempts.map(a => a.auth || a.upstream_url || '')).size
    : 0;
  const nodeRetries = uniqueTargetCount > 1 ? uniqueTargetCount - 1 : 0;

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader} onClick={handleToggleExpand}>
        <span className={`${styles.expandIcon} ${expanded ? styles.expandIconOpen : ''}`}>&#9654;</span>
        {summary.is_simulated && (
          <span className={styles.simulatedBadge}>{t('detailed_requests.simulated_tag', { defaultValue: '模拟' })}</span>
        )}
        <span className={styles.methodBadge}>{summary.method}</span>
        <span className={styles.pathText}>{summary.url}</span>
        {summary.model && <span className={styles.modelBadge}>{summary.model}</span>}
        <span className={`${styles.statusBadge} ${statusClass(summary.status_code)}`}>
          {summary.status_code}
        </span>
        <span className={styles.headerSpacer} aria-hidden />
        <span className={styles.blockActions} onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={styles.blockDlBtn}
            onClick={handleDownloadRecord}
            title={t('detailed_requests.download_full', { defaultValue: '下载完整记录' })}
          >
            ↓
          </button>
        </span>
        <div className={styles.meta}>
          {summary.api_key && <span className={styles.apiKeyTag}>{summary.api_key}</span>}
          <span className={`${styles.metaItem} ${styles.durationText}`}>{summary.total_duration_ms}ms</span>
          {hasAttempts && (
            <span className={styles.metaItem}>
              {summary.attempt_count} attempt{summary.attempt_count > 1 ? 's' : ''}
            </span>
          )}
          <span className={styles.timestampText}>{fmtTime(summary.timestamp)}</span>
        </div>
      </div>

      <div className={`${styles.cardBody} ${expanded ? styles.cardBodyOpen : ''}`}>
        {loadingDetail ? (
          <div className={styles.loadingState} style={{ padding: '12px 0' }}>{t('common.loading')}</div>
        ) : record ? (
          <>
            <div className={styles.actions}>
              <Button size="sm" onClick={() => onCopyCurl(record.id)}>
                {t('detailed_requests.copy_curl')}
              </Button>
              <span className={styles.fullTimestamp}>{fmtDate(record.timestamp)}</span>
              {record.is_streaming && <span className={styles.streamBadge}>Streaming</span>}
            </div>

            <DataBlock
              title={<>{t('detailed_requests.client_request')}{(() => { const fmt = inferRequestFormat(record.url); return fmt ? <span className={styles.formatBadge} title={t('detailed_requests.format_label', { defaultValue: '格式' })}>{fmt}</span> : null; })()}</>}
              headers={record.request_headers}
              body={record.request_body}
              downloadPrefix={`${record.id}-client-request`}
            />

            {showRetriesBlock && attempts.length > 0 && (
              <div className={styles.retryBlock}>
                <div
                  className={styles.retryBlockTitle}
                  onClick={() => setRetriesBlockOpen(!retriesBlockOpen)}
                >
                  <span className={`${styles.blockArrow} ${retriesBlockOpen ? styles.blockArrowOpen : ''}`}>&#9654;</span>
                  {t('detailed_requests.internal_processing', { defaultValue: '内部处理过程' })}
                  <span className={styles.inlineAttemptCount}>
                    {attempts.length} {t('detailed_requests.attempts_unit', { defaultValue: '次尝试' })}
                    {nodeRetries > 0 && ` (${nodeRetries} ${nodeRetries === 1 ? 'retry' : 'retries'})`}
                  </span>
                </div>
                {retriesBlockOpen && (
                  <div className={styles.retryBlockContent}>
                    <ProcessingDetailsList attempts={attempts} />
                  </div>
                )}
              </div>
            )}

            <DataBlock
              title={t('detailed_requests.final_response')}
              headers={record.response_headers}
              body={record.response_body}
              titleClass={
                record.status_code >= 200 && record.status_code < 300
                  ? styles.blockTitleSuccess
                  : record.status_code >= 400
                    ? styles.blockTitleError
                    : undefined
              }
              defaultOpen={false}
              downloadPrefix={`${record.id}-response`}
            />

            {record.error && (
              <DataBlock
                title={t('detailed_requests.error')}
                body={record.error}
                titleClass={styles.blockTitleError}
                defaultOpen
                downloadPrefix={`${record.id}-error`}
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                      */
/* ------------------------------------------------------------------ */

export function DetailedRequestsTab({ disabled, fullPage }: Props) {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();

  // Status
  const [logEnabled, setLogEnabled] = useState(false);
  const [recordCount, setRecordCount] = useState<number | undefined>();
  const [sizeMb, setSizeMb] = useState<string | undefined>();

  // Records (summaries only; full details loaded on demand per card)
  const [records, setRecords] = useState<DetailedRequestSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [apiKeys, setApiKeys] = useState<string[]>([]);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [apiKeyFilter, setApiKeyFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [timePreset, setTimePreset] = useState(0); // 0 = all, hours otherwise
  const [timeAfter, setTimeAfter] = useState('');
  const [timeBefore, setTimeBefore] = useState('');

  // Auto-refresh；显示重试部分默认 false，实际以 loadStatus 拉取的后端状态为准
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [showRetriesBlock, setShowRetriesBlock] = useState(false);
  const [showSimulated, setShowSimulated] = useState(false);
  const autoRefreshRef = useRef(true);
  const requestVersion = useRef(0);
  const lastIds = useRef('');
  const recordCache = useRef(new Map<string, DetailedRequestSummary>());

  // Keep ref in sync
  useEffect(() => {
    autoRefreshRef.current = autoRefresh;
  }, [autoRefresh]);

  /* ---- Data loading ---- */

  const loadStatus = useCallback(async () => {
    try {
      const data = await detailedRequestsApi.getStatus();
      setLogEnabled(data['detailed-request-log']);
      if (data['detailed-request-log-show-retries'] !== undefined) {
        setShowRetriesBlock(data['detailed-request-log-show-retries']);
      }
      if (data['detailed-request-log-show-simulated'] !== undefined) {
        setShowSimulated(data['detailed-request-log-show-simulated']);
      }
      setRecordCount(data.record_count);
      setSizeMb(data.size_mb);
    } catch {
      // ignore
    }
  }, []);

  const loadRecords = useCallback(async (currentOffset: number, silent = false) => {
    const version = ++requestVersion.current;

    if (!silent) {
      setLoading(true);
    }

    const params: DetailedRequestsQuery = {
      limit: PAGE_SIZE,
      offset: currentOffset,
    };
    if (apiKeyFilter) params.api_key = apiKeyFilter;
    if (statusFilter) params.status_code = statusFilter;
    if (showSimulated) params.include_simulated = true;

    if (timePreset > 0) {
      params.after = Math.floor((Date.now() - timePreset * 3600000) / 1000);
    } else {
      if (timeAfter) params.after = Math.floor(new Date(timeAfter).getTime() / 1000);
    }
    if (timeBefore) params.before = Math.floor(new Date(timeBefore).getTime() / 1000);

    const cachedIds = Array.from(recordCache.current.keys());
    if (cachedIds.length > 0) {
      params.known_ids = cachedIds.join(',');
    }

    try {
      const data = await detailedRequestsApi.listRecords(params);
      if (requestVersion.current !== version) return;

      const rawRecords: RecordOrCached[] = data.records || [];
      const resolved: DetailedRequestSummary[] = [];
      for (const entry of rawRecords) {
        if ('cached' in entry && entry.cached) {
          const cached = recordCache.current.get(entry.id);
          if (cached) {
            resolved.push(cached);
          }
        } else {
          const summary = entry as DetailedRequestSummary;
          recordCache.current.set(summary.id, summary);
          resolved.push(summary);
        }
      }

      const newIds = resolved.map((r) => `${r.id}:${r.status_code}`).join(',');
      if (newIds !== lastIds.current) {
        setRecords(resolved);
        lastIds.current = newIds;
      }

      setTotal(data.total || 0);
      setApiKeys(data.api_keys || []);
    } catch {
      if (requestVersion.current !== version) return;
      setRecords([]);
    } finally {
      if (requestVersion.current === version) {
        setLoading(false);
      }
    }

    loadStatus();
  }, [apiKeyFilter, statusFilter, timePreset, timeAfter, timeBefore, showSimulated, loadStatus]);

  /* ---- Effects ---- */

  // Load on filter/offset change
  useEffect(() => {
    lastIds.current = '';
    setOffset(0);
    loadRecords(0);
  }, [loadRecords]);

  // Auto-refresh
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      if (autoRefreshRef.current && offset === 0) {
        loadRecords(0, true);
      }
    }, AUTO_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [autoRefresh, offset, loadRecords]);

  /* ---- Handlers ---- */

  const handleToggleEnabled = async (enabled: boolean) => {
    const prev = logEnabled;
    setLogEnabled(enabled); // 乐观更新：先更新 UI，再请求
    try {
      await detailedRequestsApi.setEnabled(enabled);
      showNotification(
        enabled
          ? t('detailed_requests.logging_enabled')
          : t('detailed_requests.logging_disabled'),
        'success'
      );
      loadStatus();
    } catch {
      setLogEnabled(prev); // 失败时回滚
      showNotification(t('detailed_requests.toggle_failed'), 'error');
    }
  };

  const handleToggleShowRetries = async (show: boolean) => {
    const prev = showRetriesBlock;
    setShowRetriesBlock(show);
    try {
      await detailedRequestsApi.setShowRetries(show);
    } catch {
      setShowRetriesBlock(prev);
      showNotification(t('detailed_requests.toggle_failed'), 'error');
    }
  };

  const handleToggleShowSimulated = async (show: boolean) => {
    const prev = showSimulated;
    setShowSimulated(show);
    lastIds.current = '';
    try {
      await detailedRequestsApi.setShowSimulated(show);
    } catch {
      setShowSimulated(prev);
      showNotification(t('detailed_requests.toggle_failed'), 'error');
    }
  };

  const handleDeleteAll = () => {
    showConfirmation({
      title: t('detailed_requests.delete_all'),
      message: t('detailed_requests.delete_all_confirm'),
      variant: 'danger',
      confirmText: t('common.delete'),
      onConfirm: async () => {
        try {
          await detailedRequestsApi.deleteAll();
          lastIds.current = '';
          recordCache.current.clear();
          setRecords([]);
          setTotal(0);
          showNotification(t('detailed_requests.delete_all_success'), 'success');
          loadStatus();
        } catch {
          showNotification(t('detailed_requests.delete_all_failed'), 'error');
        }
      },
    });
  };

  const handleCopyCurl = async (id: string) => {
    try {
      const data = await detailedRequestsApi.getRecord(id);
      if (data.curl) {
        await navigator.clipboard.writeText(data.curl);
        showNotification(t('detailed_requests.curl_copied'), 'success');
      }
    } catch {
      showNotification(t('detailed_requests.curl_copy_failed'), 'error');
    }
  };

  const handleStatusFilter = (status: string) => {
    ++requestVersion.current;
    setStatusFilter(status);
    setOffset(0);
    lastIds.current = '';
    recordCache.current.clear();
    setLoading(true);
    setRecords([]);
  };

  const handleApiKeyChange = (value: string) => {
    ++requestVersion.current;
    setApiKeyFilter(value);
    setOffset(0);
    lastIds.current = '';
    recordCache.current.clear();
    setLoading(true);
    setRecords([]);
  };

  const handleTimePreset = (hours: number) => {
    ++requestVersion.current;
    setTimePreset(hours);
    if (hours === 0) {
      setTimeAfter('');
      setTimeBefore('');
    } else {
      setTimeAfter(toLocalISO(new Date(Date.now() - hours * 3600000)));
      setTimeBefore('');
    }
    setOffset(0);
    lastIds.current = '';
    recordCache.current.clear();
    setLoading(true);
    setRecords([]);
  };

  const handleCustomTime = () => {
    ++requestVersion.current;
    setTimePreset(-1); // custom
    setOffset(0);
    lastIds.current = '';
    recordCache.current.clear();
    setLoading(true);
    setRecords([]);
  };

  const handleRefresh = () => {
    lastIds.current = '';
    loadRecords(offset);
  };

  const handlePage = (dir: number) => {
    const newOffset = Math.max(0, offset + dir * PAGE_SIZE);
    ++requestVersion.current;
    setOffset(newOffset);
    lastIds.current = '';
    setLoading(true);
    setRecords([]);
    loadRecords(newOffset);
  };

  /* ---- Render ---- */

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;
  const timePresets = [
    { label: t('detailed_requests.time_all'), hours: 0 },
    { label: '1h', hours: 1 },
    { label: '6h', hours: 6 },
    { label: '1d', hours: 24 },
    { label: '1w', hours: 168 },
  ];

  return (
    <div className={`${styles.container} ${fullPage ? styles.containerFullPage : ''}`}>
      {/* Toolbar */}
      <div className={styles.toolbar}>
        <div className={styles.toggleGroup}>
          <span className={styles.toggleLabel}>{t('detailed_requests.enable_logging')}</span>
          <ToggleSwitch
            checked={logEnabled}
            onChange={handleToggleEnabled}
            disabled={disabled}
          />
        </div>
        <div className={styles.toggleGroup}>
          <span className={styles.toggleLabel}>{t('detailed_requests.show_processing_details', { defaultValue: '显示处理详情' })}</span>
          <ToggleSwitch
            checked={showRetriesBlock}
            onChange={handleToggleShowRetries}
            disabled={disabled}
          />
        </div>
        <div className={styles.toggleGroup}>
          <span className={styles.toggleLabel}>{t('detailed_requests.show_simulated', { defaultValue: '显示模拟路由' })}</span>
          <ToggleSwitch
            checked={showSimulated}
            onChange={handleToggleShowSimulated}
            disabled={disabled}
          />
        </div>
        <div className={styles.toggleGroup}>
          <span className={styles.toggleLabel}>{t('detailed_requests.auto_refresh')}</span>
          <ToggleSwitch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            disabled={disabled}
          />
          {autoRefresh && <span className={styles.refreshDot} aria-hidden />}
        </div>
        <div className={styles.statsInfo}>
          {recordCount !== undefined && <span>{recordCount} {t('detailed_requests.records')}</span>}
          {sizeMb !== undefined && <span>{sizeMb} MB</span>}
        </div>
        <Button size="sm" variant="danger" onClick={handleDeleteAll} disabled={disabled}>
          {t('detailed_requests.clear_all')}
        </Button>
        <Button size="sm" variant="secondary" onClick={handleRefresh} disabled={disabled}>
          {t('common.refresh')}
        </Button>
      </div>

      {/* Filters */}
      <div className={styles.filterBar}>
        <select
          className={styles.filterSelect}
          value={apiKeyFilter}
          onChange={(e) => handleApiKeyChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">{t('detailed_requests.all_api_keys')}</option>
          {apiKeys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>

        <div className={styles.statusChips}>
          {['', '2xx', '4xx', '5xx'].map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.chip} ${statusFilter === s ? styles.chipActive : ''}`}
              onClick={() => handleStatusFilter(s)}
              disabled={disabled}
            >
              {s || t('detailed_requests.status_all')}
            </button>
          ))}
        </div>

        <div className={styles.timeRange}>
          <div className={styles.timePresets}>
            {timePresets.map((p) => (
              <button
                key={p.hours}
                type="button"
                className={`${styles.chip} ${timePreset === p.hours ? styles.chipActive : ''}`}
                onClick={() => handleTimePreset(p.hours)}
                disabled={disabled}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            type="datetime-local"
            className={styles.timeInput}
            value={timeAfter}
            onChange={(e) => { setTimeAfter(e.target.value); handleCustomTime(); }}
            step="1"
            title={t('detailed_requests.time_from')}
          />
          <span className={styles.timeSep}>-</span>
          <input
            type="datetime-local"
            className={styles.timeInput}
            value={timeBefore}
            onChange={(e) => { setTimeBefore(e.target.value); handleCustomTime(); }}
            step="1"
            title={t('detailed_requests.time_to')}
          />
        </div>
      </div>

      {/* Record list: in embedded mode wrap in bordered box so size is constrained and only inner area scrolls */}
      {(() => {
        const listContent = loading ? (
          <div className={styles.loadingState}>{t('common.loading')}</div>
        ) : records.length === 0 ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyTitle}>{t('detailed_requests.no_records')}</div>
            <p>{t('detailed_requests.no_records_desc')}</p>
          </div>
        ) : (
          records.map((r) => (
            <RecordCard
              key={r.id}
              summary={r}
              onCopyCurl={handleCopyCurl}
              showRetriesBlock={showRetriesBlock}
            />
          ))
        );
        return fullPage ? (
          <div className={styles.cardList}>
            {listContent}
          </div>
        ) : (
          <div className={styles.cardListBox}>
            <div className={styles.cardListScroll}>
              <div className={styles.cardList}>
                {listContent}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className={styles.pagination}>
          {offset > 0 && (
            <Button size="sm" variant="secondary" onClick={() => handlePage(-1)}>
              &laquo; {t('detailed_requests.prev')}
            </Button>
          )}
          <span className={styles.paginationInfo}>
            {t('detailed_requests.page_info', { current: currentPage, total: totalPages, count: total })}
          </span>
          {offset + PAGE_SIZE < total && (
            <Button size="sm" variant="secondary" onClick={() => handlePage(1)}>
              {t('detailed_requests.next')} &raquo;
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
