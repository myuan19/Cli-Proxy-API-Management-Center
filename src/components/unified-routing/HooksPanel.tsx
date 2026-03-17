/**
 * HooksPanel — 钩子配置与执行日志面板
 *
 * 设计：每个钩子对应一个文件夹（hook-scripts/ 下的子目录），
 * 文件夹名即钩子标识，内含 run.sh 作为统一入口。
 * 面板通过下拉选择可用文件夹来绑定钩子。
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { unifiedRoutingApi } from '@/services/api/unifiedRouting';
import type { HookConfig, HookExecutionLog, HookTrigger, HookDirInfo, HookParamDef, ManualTriggerRequest } from '@/services/api/unifiedRouting';
import type { Route } from '@/types';
import styles from './HooksPanel.module.scss';

interface HooksPanelProps {
  routes: Route[];
  disabled?: boolean;
}

export function HooksPanel({ routes, disabled }: HooksPanelProps) {
  const { t } = useTranslation();

  const [hooks, setHooks] = useState<HookConfig[]>([]);
  const [logs, setLogs] = useState<HookExecutionLog[]>([]);
  const [availableDirs, setAvailableDirs] = useState<HookDirInfo[]>([]);
  const [scriptsDir, setScriptsDir] = useState('');
  const [loading, setLoading] = useState(true);
  const [logsLoading, setLogsLoading] = useState(false);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingHook, setEditingHook] = useState<HookConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const [logsExpanded, setLogsExpanded] = useState(false);
  const [logDetailModal, setLogDetailModal] = useState<HookExecutionLog | null>(null);

  // Manual trigger state — supports concurrent executions
  const [triggerModalOpen, setTriggerModalOpen] = useState(false);
  const [triggerHookId, setTriggerHookId] = useState('');
  const [triggerHookName, setTriggerHookName] = useState('');
  const [triggerRunning, setTriggerRunning] = useState(false);
  const [triggerLogLines, setTriggerLogLines] = useState<Array<{ stream: string; line: string }>>([]);
  const [triggerResult, setTriggerResult] = useState<HookExecutionLog | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runningCountRef = useRef(0);
  const [triggerForm, setTriggerForm] = useState<ManualTriggerRequest>({
    route_id: '', route_name: '', target_id: '', credential_id: '',
    model: '', status_code: 401, error_message: 'Simulated error for manual trigger',
  });

  // Form state
  const [formName, setFormName] = useState('');
  const [formRouteId, setFormRouteId] = useState('');
  const [formHookDir, setFormHookDir] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formTriggerOn, setFormTriggerOn] = useState<'failure' | 'success' | 'any'>('failure');
  const [formStatusCodes, setFormStatusCodes] = useState('');
  const [formErrorContains, setFormErrorContains] = useState('');
  const [formTimeout, setFormTimeout] = useState(30);
  const [formParams, setFormParams] = useState<Record<string, string>>({});

  const fetchHooks = useCallback(async () => {
    setLoading(true);
    try {
      const [hooksRes, dirsRes] = await Promise.all([
        unifiedRoutingApi.listHooks(),
        unifiedRoutingApi.listAvailableHookDirs(),
      ]);
      setHooks(hooksRes.hooks || []);
      setAvailableDirs(dirsRes.dirs || []);
      setScriptsDir(dirsRes.scripts_dir || '');
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchLogs = useCallback(async () => {
    setLogsLoading(true);
    try {
      const res = await unifiedRoutingApi.listHookLogs(undefined, undefined, 30);
      setLogs(res.logs || []);
    } catch {
      // silent
    } finally {
      setLogsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHooks();
  }, [fetchHooks]);

  const validDirs = availableDirs.filter(d => d.has_run);

  const initParamDefaults = (dirName: string, existing?: Record<string, string>) => {
    const dir = availableDirs.find(d => d.name === dirName);
    const defaults: Record<string, string> = {};
    if (dir?.params) {
      for (const p of dir.params) {
        defaults[p.name] = existing?.[p.name] ?? p.default ?? '';
      }
    }
    return defaults;
  };

  const openCreate = () => {
    setEditingHook(null);
    setFormName('');
    setFormRouteId(routes[0]?.id || '');
    const dir = validDirs[0]?.name || '';
    setFormHookDir(dir);
    setFormEnabled(true);
    setFormTriggerOn('failure');
    setFormStatusCodes('');
    setFormErrorContains('');
    setFormTimeout(30);
    setFormParams(initParamDefaults(dir));
    setModalOpen(true);
  };

  const openEdit = (hook: HookConfig) => {
    setEditingHook(hook);
    setFormName(hook.name);
    setFormRouteId(hook.route_id);
    setFormHookDir(hook.hook_dir);
    setFormEnabled(hook.enabled);
    setFormTriggerOn(hook.trigger.on || 'failure');
    setFormStatusCodes((hook.trigger.status_codes || []).join(', '));
    setFormErrorContains(hook.trigger.error_contains || '');
    setFormTimeout(hook.timeout_seconds || 30);
    setFormParams(initParamDefaults(hook.hook_dir, hook.params));
    setModalOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formHookDir || !formRouteId) return;
    setSaving(true);

    const trigger: HookTrigger = { on: formTriggerOn };
    const codes = formStatusCodes
      .split(/[,\s]+/)
      .map(s => parseInt(s.trim(), 10))
      .filter(n => !isNaN(n) && n > 0);
    if (codes.length > 0) trigger.status_codes = codes;
    if (formErrorContains.trim()) trigger.error_contains = formErrorContains.trim();

    // Only include non-empty params
    const cleanParams: Record<string, string> = {};
    for (const [k, v] of Object.entries(formParams)) {
      if (v !== '') cleanParams[k] = v;
    }

    const payload: Partial<HookConfig> = {
      name: formName.trim(),
      route_id: formRouteId,
      hook_dir: formHookDir,
      enabled: formEnabled,
      trigger,
      timeout_seconds: formTimeout,
      params: Object.keys(cleanParams).length > 0 ? cleanParams : undefined,
    };

    try {
      if (editingHook) {
        await unifiedRoutingApi.updateHook(editingHook.id, payload);
      } else {
        await unifiedRoutingApi.createHook(payload);
      }
      setModalOpen(false);
      await fetchHooks();
    } catch {
      // silent
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (hookId: string) => {
    try {
      await unifiedRoutingApi.deleteHook(hookId);
      await fetchHooks();
    } catch {
      // silent
    }
  };

  const handleToggleEnabled = async (hook: HookConfig) => {
    try {
      await unifiedRoutingApi.updateHook(hook.id, { ...hook, enabled: !hook.enabled });
      await fetchHooks();
    } catch {
      // silent
    }
  };

  const openTrigger = (hook: HookConfig) => {
    // If the same hook is already showing in the modal, just reopen it
    if (triggerHookId === hook.id && (triggerRunning || triggerLogLines.length > 0)) {
      setTriggerModalOpen(true);
      return;
    }
    // Switching to a different hook — abort previous SSE if any
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setTriggerHookId(hook.id);
    setTriggerHookName(hook.name);
    setTriggerLogLines([]);
    setTriggerResult(null);
    setTriggerForm({
      route_id: hook.route_id,
      route_name: routeName(hook.route_id),
      target_id: 'target-manual',
      credential_id: 'token_simulated.json',
      model: 'gpt-5.2-codex',
      status_code: hook.trigger.status_codes?.[0] || 401,
      error_message: 'Simulated error for manual trigger',
    });
    setTriggerModalOpen(true);
  };

  const handleTrigger = async () => {
    if (!triggerHookId) return;

    // Abort previous SSE stream (backend process continues independently)
    if (abortRef.current) {
      abortRef.current.abort();
    }
    const controller = new AbortController();
    abortRef.current = controller;

    runningCountRef.current += 1;
    setTriggerRunning(true);
    setTriggerLogLines([]);
    setTriggerResult(null);

    try {
      await unifiedRoutingApi.triggerHookStream(triggerHookId, triggerForm, {
        onOutput: (stream, line) => {
          if (controller.signal.aborted) return;
          setTriggerLogLines(prev => [...prev, { stream, line }]);
        },
        onDone: (result) => {
          if (controller.signal.aborted) return;
          setTriggerResult(result);
          if (logsExpanded) fetchLogs();
        },
        onError: (error) => {
          if (controller.signal.aborted) return;
          setTriggerLogLines(prev => [...prev, { stream: 'stderr', line: `[ERROR] ${error}` }]);
        },
      }, controller.signal);
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      if (controller.signal.aborted) return;
      setTriggerLogLines(prev => [...prev, { stream: 'stderr', line: '[ERROR] Connection failed' }]);
    } finally {
      runningCountRef.current = Math.max(0, runningCountRef.current - 1);
      if (runningCountRef.current <= 0) {
        setTriggerRunning(false);
      }
    }
  };

  // Auto-scroll log panel
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [triggerLogLines]);

  const handleToggleLogs = () => {
    if (!logsExpanded) fetchLogs();
    setLogsExpanded(prev => !prev);
  };

  const routeName = (routeId: string) => {
    const r = routes.find(rt => rt.id === routeId);
    return r?.name || routeId;
  };

  const triggerLabel = (trigger: HookTrigger) => {
    const parts: string[] = [];
    const onLabels: Record<string, string> = { failure: '失败时', success: '成功时', any: '任意' };
    parts.push(onLabels[trigger.on] || trigger.on);
    if (trigger.status_codes?.length) parts.push(`codes: ${trigger.status_codes.join(',')}`);
    if (trigger.error_contains) parts.push(`contains: "${trigger.error_contains}"`);
    return parts.join(' | ');
  };

  const selectedDirInfo = availableDirs.find(d => d.name === formHookDir);

  return (
    <Card
      title={t('unified_routing.hooks_title', { defaultValue: '响应钩子' })}
      extra={
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <Button variant="secondary" size="sm" onClick={handleToggleLogs}>
            {t('unified_routing.hooks_logs', { defaultValue: '执行日志' })}
          </Button>
          <Button variant="secondary" size="sm" onClick={fetchHooks} disabled={loading}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" size="sm" onClick={openCreate} disabled={disabled || routes.length === 0 || validDirs.length === 0}>
            + {t('unified_routing.hooks_add', { defaultValue: '添加钩子' })}
          </Button>
        </div>
      }
    >
      {/* Scripts directory hint */}
      {scriptsDir && (
        <div className={styles.scriptsDirHint}>
          {t('unified_routing.hooks_scripts_dir_hint', {
            defaultValue: '钩子脚本目录：{{dir}} — 在此目录下创建子文件夹（含 run.sh），即可作为钩子使用',
            dir: scriptsDir,
          })}
        </div>
      )}

      {loading ? (
        <div className={styles.loading}><LoadingSpinner size={20} /></div>
      ) : validDirs.length === 0 ? (
        <div className={styles.empty}>
          <p>{t('unified_routing.hooks_no_dirs', { defaultValue: '未发现可用钩子文件夹。' })}</p>
          <p className={styles.emptyHint}>
            {t('unified_routing.hooks_no_dirs_hint', {
              defaultValue: '请在 {{dir}} 下创建子文件夹，并在其中放置 run.sh 入口脚本。例如：',
              dir: scriptsDir,
            })}
          </p>
          <pre className={styles.emptyCode}>{`${scriptsDir}/\n  my-hook/\n    run.sh      # 入口脚本\n    config.yaml # 自定义配置（可选）\n    ...`}</pre>
        </div>
      ) : hooks.length === 0 ? (
        <div className={styles.empty}>
          {t('unified_routing.hooks_empty', {
            defaultValue: '暂无钩子绑定。已发现 {{count}} 个可用钩子文件夹，点击上方按钮添加。',
            count: validDirs.length,
          })}
        </div>
      ) : (
        <div className={styles.hooksList}>
          {hooks.map(hook => (
            <div key={hook.id} className={`${styles.hookItem} ${!hook.enabled ? styles.hookItemDisabled : ''}`}>
              <div className={styles.hookItemMain}>
                <div className={styles.hookItemHeader}>
                  <ToggleSwitch
                    checked={hook.enabled}
                    onChange={() => handleToggleEnabled(hook)}
                    disabled={disabled}
                  />
                  <span className={styles.hookName}>{hook.name}</span>
                  <span className={styles.hookRoute}>{routeName(hook.route_id)}</span>
                </div>
                <div className={styles.hookMeta}>
                  <span className={styles.hookDirBadge} title={`${scriptsDir}/${hook.hook_dir}/run.sh`}>
                    📁 {hook.hook_dir}
                  </span>
                  <span className={styles.hookTrigger}>{triggerLabel(hook.trigger)}</span>
                </div>
              </div>
              <div className={styles.hookItemActions}>
                <Button variant="secondary" size="sm" onClick={() => openTrigger(hook)} disabled={disabled}>
                  {t('unified_routing.hooks_trigger', { defaultValue: '手动触发' })}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openEdit(hook)} disabled={disabled}>
                  {t('common.edit', { defaultValue: '编辑' })}
                </Button>
                <Button variant="danger" size="sm" onClick={() => handleDelete(hook.id)} disabled={disabled}>
                  {t('common.delete')}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Execution Logs */}
      {logsExpanded && (
        <div className={styles.logsSection}>
          <div className={styles.logsSectionHeader}>
            <span>{t('unified_routing.hooks_execution_logs', { defaultValue: '执行日志' })}</span>
            <Button variant="ghost" size="sm" onClick={fetchLogs} disabled={logsLoading}>
              {t('common.refresh')}
            </Button>
          </div>
          {logsLoading ? (
            <div className={styles.loading}><LoadingSpinner size={16} /></div>
          ) : logs.length === 0 ? (
            <div className={styles.empty}>{t('unified_routing.hooks_no_logs', { defaultValue: '暂无执行记录' })}</div>
          ) : (
            <div className={styles.logsList}>
              {logs.map(logItem => (
                <div
                  key={logItem.id}
                  className={`${styles.logItem} ${logItem.success ? styles.logItemSuccess : styles.logItemFail}`}
                  onClick={() => setLogDetailModal(logItem)}
                >
                  <span className={styles.logTime}>{new Date(logItem.timestamp).toLocaleString()}</span>
                  <span className={styles.logHookName}>{logItem.hook_name}</span>
                  <span className={styles.logHookDir}>📁 {logItem.hook_dir}</span>
                  <span className={styles.logRoute}>{logItem.route_name || logItem.route_id}</span>
                  <span className={styles.logReason} title={logItem.trigger_reason}>{logItem.trigger_reason}</span>
                  <span className={`${styles.logStatus} ${logItem.success ? styles.logStatusOk : styles.logStatusFail}`}>
                    {logItem.success ? `✓ ${logItem.duration_ms}ms` : `✗ exit=${logItem.exit_code}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create / Edit Modal */}
      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingHook
          ? t('unified_routing.hooks_edit', { defaultValue: '编辑钩子' })
          : t('unified_routing.hooks_add', { defaultValue: '添加钩子' })}
        width={560}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)}>{t('common.cancel')}</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving || !formName.trim() || !formHookDir}>
              {saving ? t('common.loading') : t('common.confirm', { defaultValue: '确认' })}
            </Button>
          </>
        }
      >
        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_name', { defaultValue: '钩子名称' })}</label>
          <Input value={formName} onChange={e => setFormName(e.target.value)} placeholder="e.g. rate_limit_alert" />
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_hook_dir', { defaultValue: '选择钩子文件夹' })}</label>
          {validDirs.length === 0 ? (
            <div className={styles.noDirsWarning}>
              {t('unified_routing.hooks_no_dirs_warning', {
                defaultValue: '未发现可用文件夹，请在 {{dir}} 下创建含 run.sh 的子文件夹',
                dir: scriptsDir,
              })}
            </div>
          ) : (
            <select className={styles.formSelect} value={formHookDir} onChange={e => {
              setFormHookDir(e.target.value);
              setFormParams(initParamDefaults(e.target.value));
            }}>
              {validDirs.map(d => (
                <option key={d.name} value={d.name}>{d.name}</option>
              ))}
            </select>
          )}
          {selectedDirInfo && (
            <div className={styles.dirInfoPreview}>
              <div className={styles.dirInfoPath}>{selectedDirInfo.path}/run.sh</div>
              {selectedDirInfo.files && selectedDirInfo.files.length > 0 && (
                <div className={styles.dirInfoFiles}>
                  {t('unified_routing.hooks_dir_files', { defaultValue: '包含文件：' })}
                  {selectedDirInfo.files.join(', ')}
                </div>
              )}
              {selectedDirInfo.readme && (
                <div className={styles.dirInfoReadme}>
                  <pre>{selectedDirInfo.readme}</pre>
                </div>
              )}
            </div>
          )}
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_route', { defaultValue: '关联路由' })}</label>
          <select className={styles.formSelect} value={formRouteId} onChange={e => setFormRouteId(e.target.value)}>
            {routes.map(r => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_trigger_on', { defaultValue: '触发时机' })}</label>
          <select className={styles.formSelect} value={formTriggerOn} onChange={e => setFormTriggerOn(e.target.value as 'failure' | 'success' | 'any')}>
            <option value="failure">{t('unified_routing.hooks_on_failure', { defaultValue: '请求失败时' })}</option>
            <option value="success">{t('unified_routing.hooks_on_success', { defaultValue: '请求成功时' })}</option>
            <option value="any">{t('unified_routing.hooks_on_any', { defaultValue: '任意响应' })}</option>
          </select>
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_status_codes', { defaultValue: '状态码过滤（逗号分隔，留空不过滤）' })}</label>
          <Input value={formStatusCodes} onChange={e => setFormStatusCodes(e.target.value)} placeholder="429, 503" />
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_error_contains', { defaultValue: '错误信息包含（留空不过滤）' })}</label>
          <Input value={formErrorContains} onChange={e => setFormErrorContains(e.target.value)} placeholder="rate_limit" />
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_timeout', { defaultValue: '超时秒数' })}</label>
          <Input type="number" value={String(formTimeout)} onChange={e => setFormTimeout(Number(e.target.value) || 30)} />
        </div>

        <div className={styles.formGroup}>
          <label>{t('unified_routing.hooks_enabled', { defaultValue: '启用' })}</label>
          <ToggleSwitch checked={formEnabled} onChange={setFormEnabled} />
        </div>

        {/* Dynamic hook params from params.json */}
        {selectedDirInfo?.params && selectedDirInfo.params.length > 0 && (
          <div className={styles.paramsSection}>
            <div className={styles.paramsSectionTitle}>
              {t('unified_routing.hooks_params_title', { defaultValue: '钩子参数' })}
            </div>
            {selectedDirInfo.params.map((paramDef: HookParamDef) => (
              <div key={paramDef.name} className={styles.formGroup}>
                <label>
                  {paramDef.label || paramDef.name}
                  {paramDef.required && <span className={styles.paramRequired}> *</span>}
                </label>
                {paramDef.description && (
                  <div className={styles.paramDescription}>{paramDef.description}</div>
                )}
                {paramDef.type === 'select' && paramDef.options ? (
                  <select
                    className={styles.formSelect}
                    value={formParams[paramDef.name] ?? paramDef.default ?? ''}
                    onChange={e => setFormParams(prev => ({ ...prev, [paramDef.name]: e.target.value }))}
                  >
                    {paramDef.options.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                ) : (
                  <Input
                    type={paramDef.type === 'password' ? 'password' : paramDef.type === 'number' ? 'number' : 'text'}
                    value={formParams[paramDef.name] ?? ''}
                    onChange={e => setFormParams(prev => ({ ...prev, [paramDef.name]: e.target.value }))}
                    placeholder={paramDef.default || ''}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Modal>

      {/* Manual Trigger Modal */}
      <Modal
        open={triggerModalOpen}
        onClose={() => setTriggerModalOpen(false)}
        title={t('unified_routing.hooks_trigger_title', { defaultValue: '手动触发钩子' }) + ` — ${triggerHookName}`}
        width={triggerLogLines.length > 0 || triggerRunning ? 1000 : 520}
        footer={
          <>
            <Button variant="secondary" onClick={() => setTriggerModalOpen(false)}>
              {triggerResult ? t('common.close') : triggerRunning ? t('unified_routing.hooks_trigger_hide', { defaultValue: '隐藏' }) : t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleTrigger}>
              {triggerRunning
                ? t('unified_routing.hooks_trigger_rerun', { defaultValue: '再次执行' })
                : triggerResult
                  ? t('unified_routing.hooks_trigger_rerun', { defaultValue: '再次执行' })
                  : t('unified_routing.hooks_trigger_run', { defaultValue: '执行' })}
            </Button>
          </>
        }
      >
        <div className={styles.triggerLayout}>
          <div className={styles.triggerFormSide}>
            <div className={styles.triggerHint}>
              {t('unified_routing.hooks_trigger_hint', {
                defaultValue: '以下数据为模拟输入，将作为环境变量传递给 run.sh。可自由修改以测试不同场景。',
              })}
            </div>
            <div className={styles.formGroup}>
              <label>Route ID</label>
              <Input value={triggerForm.route_id || ''} onChange={e => setTriggerForm(f => ({ ...f, route_id: e.target.value }))} disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Route Name</label>
              <Input value={triggerForm.route_name || ''} onChange={e => setTriggerForm(f => ({ ...f, route_name: e.target.value }))} disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Credential ID</label>
              <Input value={triggerForm.credential_id || ''} onChange={e => setTriggerForm(f => ({ ...f, credential_id: e.target.value }))} placeholder="token_xxx.json" disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Model</label>
              <Input value={triggerForm.model || ''} onChange={e => setTriggerForm(f => ({ ...f, model: e.target.value }))} placeholder="gpt-5.2-codex" disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Status Code</label>
              <Input type="number" value={String(triggerForm.status_code || 0)} onChange={e => setTriggerForm(f => ({ ...f, status_code: Number(e.target.value) || 0 }))} disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Error Message</label>
              <Input value={triggerForm.error_message || ''} onChange={e => setTriggerForm(f => ({ ...f, error_message: e.target.value }))} placeholder="Simulated error" disabled={triggerRunning} />
            </div>
            <div className={styles.formGroup}>
              <label>Target ID</label>
              <Input value={triggerForm.target_id || ''} onChange={e => setTriggerForm(f => ({ ...f, target_id: e.target.value }))} placeholder="target-xxx" disabled={triggerRunning} />
            </div>
          </div>
          {(triggerLogLines.length > 0 || triggerRunning) && (
            <div className={styles.triggerLogSide}>
              <div className={styles.triggerLogHeader}>
                <span>实时日志</span>
                {triggerRunning && <LoadingSpinner size={14} />}
                {triggerResult && (
                  <span className={triggerResult.success ? styles.logStatusOk : styles.logStatusFail}>
                    {triggerResult.success ? `✓ 成功 (${triggerResult.duration_ms}ms)` : `✗ 失败 (exit=${triggerResult.exit_code})`}
                  </span>
                )}
              </div>
              <div className={styles.triggerLogContent}>
                {triggerLogLines.map((item, i) => (
                  <div
                    key={i}
                    className={`${styles.triggerLogLine} ${item.stream === 'stderr' ? styles.triggerLogLineErr : ''}`}
                  >
                    {item.line}
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </div>
      </Modal>

      {/* Log Detail Modal */}
      <Modal
        open={logDetailModal !== null}
        onClose={() => setLogDetailModal(null)}
        title={t('unified_routing.hooks_log_detail', { defaultValue: '执行详情' })}
        width={640}
        footer={
          <Button variant="secondary" onClick={() => setLogDetailModal(null)}>{t('common.close')}</Button>
        }
      >
        {logDetailModal && (
          <div className={styles.logDetail}>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_name', { defaultValue: '钩子' })}</span>
              <span>{logDetailModal.hook_name}</span>
            </div>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_hook_dir', { defaultValue: '文件夹' })}</span>
              <span className={styles.logDetailMono}>{logDetailModal.hook_dir}/run.sh</span>
            </div>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_route', { defaultValue: '路由' })}</span>
              <span>{logDetailModal.route_name || logDetailModal.route_id}</span>
            </div>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>Target</span>
              <span>{logDetailModal.credential_id} / {logDetailModal.model}</span>
            </div>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_trigger_reason', { defaultValue: '触发原因' })}</span>
              <span>{logDetailModal.trigger_reason}</span>
            </div>
            {(logDetailModal.status_code ?? 0) > 0 && (
              <div className={styles.logDetailRow}>
                <span className={styles.logDetailLabel}>Status Code</span>
                <span>{logDetailModal.status_code}</span>
              </div>
            )}
            {logDetailModal.error_message && (
              <div className={styles.logDetailRow}>
                <span className={styles.logDetailLabel}>Error</span>
                <span className={styles.logDetailError}>{logDetailModal.error_message}</span>
              </div>
            )}
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_result', { defaultValue: '结果' })}</span>
              <span className={logDetailModal.success ? styles.logStatusOk : styles.logStatusFail}>
                {logDetailModal.success ? '成功' : `失败 (exit=${logDetailModal.exit_code})`}
              </span>
            </div>
            <div className={styles.logDetailRow}>
              <span className={styles.logDetailLabel}>{t('unified_routing.hooks_duration', { defaultValue: '耗时' })}</span>
              <span>{logDetailModal.duration_ms}ms</span>
            </div>
            {logDetailModal.stdout && (
              <div className={styles.logDetailBlock}>
                <label>stdout</label>
                <pre>{logDetailModal.stdout}</pre>
              </div>
            )}
            {logDetailModal.stderr && (
              <div className={styles.logDetailBlock}>
                <label>stderr</label>
                <pre>{logDetailModal.stderr}</pre>
              </div>
            )}
          </div>
        )}
      </Modal>
    </Card>
  );
}
