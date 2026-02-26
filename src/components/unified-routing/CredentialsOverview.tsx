/**
 * Credentials Overview Component
 * Two-column layout rendered directly (no Card wrapper).
 * Left: providers with credential cards (2×3 grid, paginated), top-right has check/batch/toggle buttons.
 * Right: models panel — manual input + model list (each with × to remove).
 * Clicking a credential opens a modal showing its models with "+" buttons to add to the right panel.
 * "添加模型" global toggle controls credential selection mode for batch-add.
 */

import { useState, useMemo, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconBot } from '@/components/ui/icons';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { unifiedRoutingApi } from '@/services/api/unifiedRouting';
import { getCredentialDisplayLabel } from '@/utils/unifiedRouting';
import type { CredentialInfo, Route, Pipeline, Target, Layer, ModelInfo } from '@/types';
import styles from './CredentialsOverview.module.scss';

const CREDENTIALS_PAGE_SIZE = 6;
const CHECK_CONCURRENCY = 10;

interface CredentialsOverviewProps {
  credentials: CredentialInfo[];
  loading?: boolean;
  routes?: Route[];
  routePipelines?: Record<string, Pipeline | null>;
  onPipelineChange?: (routeId: string, pipeline: Pipeline) => void;
  addingModelsMode?: boolean;
  onValidCombinationCountChange?: (count: number) => void;
  onSelectedCountsChange?: (creds: number, models: number) => void;
  onCheckingAllChange?: (checking: boolean) => void;
}

export interface CredentialsOverviewRef {
  openBatchAddModal: () => void;
  checkAllCredentials: () => void;
}

export const CredentialsOverview = forwardRef<CredentialsOverviewRef, CredentialsOverviewProps>(function CredentialsOverview({
  credentials,
  loading,
  routes,
  routePipelines,
  onPipelineChange,
  addingModelsMode: addingModelsModeProp = false,
  onValidCombinationCountChange,
  onSelectedCountsChange,
  onCheckingAllChange,
}, ref) {
  const { t } = useTranslation();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [credentialPage, setCredentialPage] = useState<Record<string, number>>({});
  const addingModelsMode = addingModelsModeProp;
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<Set<string>>(new Set());
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [batchAddModalOpen, setBatchAddModalOpen] = useState(false);
  const [batchAddTarget, setBatchAddTarget] = useState<{ routeId: string; layerLevel: number } | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customModelInput, setCustomModelInput] = useState('');

  const [credentialCheckStatus, setCredentialCheckStatus] = useState<Record<string, 'success' | 'error'>>({});
  const [checkingCredentials, setCheckingCredentials] = useState(false);
  const [checkingProvider, setCheckingProvider] = useState<string | null>(null);

  const [credentialModalCred, setCredentialModalCred] = useState<CredentialInfo | null>(null);
  const [credentialModalModels, setCredentialModalModels] = useState<ModelInfo[] | null>(null);
  const [credentialModalLoading, setCredentialModalLoading] = useState(false);

  const groupedCredentials = useMemo(() => {
    const groups: Record<string, CredentialInfo[]> = {};
    for (const cred of credentials) {
      const key = cred.provider;
      if (!groups[key]) groups[key] = [];
      groups[key].push(cred);
    }
    return groups;
  }, [credentials]);

  const providers = useMemo(() => Object.keys(groupedCredentials).sort(), [groupedCredentials]);

  // 默认展开所有 provider 分组（仅首次加载时，不覆盖用户手动折叠）
  const [hasInitializedExpanded, setHasInitializedExpanded] = useState(false);
  useEffect(() => {
    if (providers.length > 0 && !hasInitializedExpanded) {
      setExpandedProviders(new Set(providers));
      setHasInitializedExpanded(true);
    }
  }, [providers, hasInitializedExpanded]);

  // ========== Check credentials (10 concurrency) ==========
  const handleCheckAllCredentials = useCallback(async () => {
    if (checkingCredentials) return;
    const allCreds = credentials.filter(c => c.status !== 'disabled');
    if (allCreds.length === 0) return;
    setCheckingCredentials(true);
    setCredentialCheckStatus({});
    let idx = 0;
    const run = async () => {
      while (idx < allCreds.length) {
        const cred = allCreds[idx++];
        try {
          const c = await unifiedRoutingApi.getCredential(cred.id);
          setCredentialCheckStatus(prev => ({
            ...prev,
            [cred.id]: (c.models?.length ?? 0) > 0 ? 'success' : 'error',
          }));
        } catch {
          setCredentialCheckStatus(prev => ({ ...prev, [cred.id]: 'error' }));
        }
      }
    };
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, allCreds.length) }, () => run());
    await Promise.all(workers);
    setCheckingCredentials(false);
  }, [credentials, checkingCredentials]);

  const handleCheckProviderCredentials = useCallback(async (provider: string) => {
    if (checkingCredentials || checkingProvider) return;
    const creds = (groupedCredentials[provider] ?? []).filter(c => c.status !== 'disabled');
    if (creds.length === 0) return;
    setCheckingProvider(provider);
    let idx = 0;
    const run = async () => {
      while (idx < creds.length) {
        const cred = creds[idx++];
        try {
          const c = await unifiedRoutingApi.getCredential(cred.id);
          setCredentialCheckStatus(prev => ({
            ...prev,
            [cred.id]: (c.models?.length ?? 0) > 0 ? 'success' : 'error',
          }));
        } catch {
          setCredentialCheckStatus(prev => ({ ...prev, [cred.id]: 'error' }));
        }
      }
    };
    const workers = Array.from({ length: Math.min(CHECK_CONCURRENCY, creds.length) }, () => run());
    await Promise.all(workers);
    setCheckingProvider(null);
  }, [groupedCredentials, checkingCredentials, checkingProvider]);

  // ========== Credential models modal ==========
  const openCredentialModelsModal = useCallback((cred: CredentialInfo) => {
    setCredentialModalCred(cred);
    setCredentialModalModels(null);
  }, []);

  const closeCredentialModelsModal = useCallback(() => {
    setCredentialModalCred(null);
    setCredentialModalModels(null);
  }, []);

  useEffect(() => {
    if (!credentialModalCred) return;
    setCredentialModalLoading(true);
    unifiedRoutingApi
      .getCredential(credentialModalCred.id)
      .then((c) => setCredentialModalModels(c.models || []))
      .catch(() => setCredentialModalModels([]))
      .finally(() => setCredentialModalLoading(false));
  }, [credentialModalCred]);

  const handleAddModelFromModal = useCallback((modelId: string) => {
    setCustomModels(prev => prev.includes(modelId) ? prev : [...prev, modelId]);
  }, []);

  // ========== Provider toggle / pagination ==========
  const toggleProvider = useCallback((provider: string) => {
    setExpandedProviders(prev => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }, []);

  const credsForProviderPage = useCallback(
    (provider: string, page: number) => {
      const list = groupedCredentials[provider] ?? [];
      return list.slice(page * CREDENTIALS_PAGE_SIZE, (page + 1) * CREDENTIALS_PAGE_SIZE);
    },
    [groupedCredentials]
  );

  const totalCredPages = useCallback(
    (provider: string) => Math.ceil((groupedCredentials[provider]?.length ?? 0) / CREDENTIALS_PAGE_SIZE),
    [groupedCredentials]
  );

  // ========== Selection ==========
  const toggleCredentialSelection = useCallback((id: string) => {
    setSelectedCredentialIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAllProvider = useCallback(
    (provider: string) => {
      const list = groupedCredentials[provider] ?? [];
      setSelectedCredentialIds(prev => {
        const allSelected = list.every(c => prev.has(c.id));
        if (allSelected) {
          const next = new Set(prev);
          list.forEach(c => next.delete(c.id));
          return next;
        }
        return new Set([...prev, ...list.map(c => c.id)]);
      });
    },
    [groupedCredentials]
  );

  const isProviderAllSelected = useCallback(
    (provider: string) => {
      const list = groupedCredentials[provider] ?? [];
      return list.length > 0 && list.every(c => selectedCredentialIds.has(c.id));
    },
    [groupedCredentials, selectedCredentialIds]
  );

  const selectedCountForProvider = useCallback(
    (provider: string) => {
      const list = groupedCredentials[provider] ?? [];
      return list.filter(c => selectedCredentialIds.has(c.id)).length;
    },
    [groupedCredentials, selectedCredentialIds]
  );

  const checkCountsForProvider = useCallback(
    (provider: string): { success: number; error: number } => {
      const list = groupedCredentials[provider] ?? [];
      let success = 0;
      let error = 0;
      for (const c of list) {
        const s = credentialCheckStatus[c.id];
        if (s === 'success') success++;
        else if (s === 'error') error++;
      }
      return { success, error };
    },
    [groupedCredentials, credentialCheckStatus]
  );

  const toggleModelSelection = useCallback((modelId: string) => {
    setSelectedModelIds(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  const validCombinationCount = useMemo(() => {
    if (selectedCredentialIds.size === 0 || selectedModelIds.size === 0) return 0;
    return selectedCredentialIds.size * selectedModelIds.size;
  }, [selectedCredentialIds, selectedModelIds]);

  useEffect(() => {
    onValidCombinationCountChange?.(validCombinationCount);
  }, [validCombinationCount, onValidCombinationCountChange]);

  useEffect(() => {
    onSelectedCountsChange?.(selectedCredentialIds.size, selectedModelIds.size);
  }, [selectedCredentialIds.size, selectedModelIds.size, onSelectedCountsChange]);

  useEffect(() => {
    onCheckingAllChange?.(checkingCredentials);
  }, [checkingCredentials, onCheckingAllChange]);

  useImperativeHandle(ref, () => ({
    openBatchAddModal: () => setBatchAddModalOpen(true),
    checkAllCredentials: handleCheckAllCredentials,
  }), [handleCheckAllCredentials]);

  const handleAddCustomModel = useCallback(() => {
    const trimmed = customModelInput.trim();
    if (!trimmed) return;
    setCustomModels(prev => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    setCustomModelInput('');
  }, [customModelInput]);

  // ========== Batch add ==========
  const handleBatchAddConfirm = useCallback(async () => {
    if (!batchAddTarget || !onPipelineChange || !routePipelines) return;
    const newTargets: Target[] = [];
    for (const cid of selectedCredentialIds) {
      for (const mid of selectedModelIds) {
        newTargets.push({ id: crypto.randomUUID(), credential_id: cid, model: mid, enabled: true });
      }
    }
    if (newTargets.length === 0) return;
    const { routeId, layerLevel } = batchAddTarget;
    let pipeline = routePipelines[routeId];
    if (!pipeline) pipeline = { route_id: routeId, layers: [] };
    const layerExists = pipeline.layers.some(l => l.level === layerLevel);
    let newPipeline: Pipeline;
    if (layerExists) {
      newPipeline = {
        ...pipeline,
        layers: pipeline.layers.map(layer =>
          layer.level !== layerLevel ? layer : { ...layer, targets: [...layer.targets, ...newTargets] }
        ),
      };
    } else {
      const newLayer: Layer = { level: layerLevel, strategy: 'round-robin', targets: newTargets };
      newPipeline = { ...pipeline, layers: [...pipeline.layers, newLayer].sort((a, b) => a.level - b.level) };
    }
    await onPipelineChange(routeId, newPipeline);
    setBatchAddModalOpen(false);
    setBatchAddTarget(null);
  }, [batchAddTarget, onPipelineChange, routePipelines, selectedCredentialIds, selectedModelIds]);

  const availableRoutes = useMemo(() => {
    if (!routes || !routePipelines) return [];
    return routes.map(r => ({ route: r, pipeline: routePipelines[r.id] }));
  }, [routes, routePipelines]);

  const selectedCredsByProvider = useMemo(() => {
    const result: Record<string, CredentialInfo[]> = {};
    for (const cred of credentials) {
      if (selectedCredentialIds.has(cred.id)) {
        if (!result[cred.provider]) result[cred.provider] = [];
        result[cred.provider].push(cred);
      }
    }
    return result;
  }, [credentials, selectedCredentialIds]);

  const selectedModelsList = useMemo(() => [...selectedModelIds], [selectedModelIds]);

  // ========== Loading / Empty ==========
  if (loading) {
    return <div className={styles.statusMsg}>{t('common.loading')}</div>;
  }

  if (credentials.length === 0) {
    return <div className={styles.statusMsg}>{t('unified_routing.no_credentials')}</div>;
  }

  return (
    <>
      <div className={styles.overviewLayout}>
        {/* ===== Left: Credentials ===== */}
        <div className={styles.overviewLeft}>
          <div className={styles.providerList}>
            {providers.map(provider => {
              const isExpanded = expandedProviders.has(provider);
              const creds = groupedCredentials[provider];
              const page = credentialPage[provider] ?? 0;
              const totalPages = totalCredPages(provider);
              const pageCreds = credsForProviderPage(provider, page);
              const isAllSelected = isProviderAllSelected(provider);
              const selCount = selectedCountForProvider(provider);
              const checkCounts = checkCountsForProvider(provider);
              const hasCheckResults = checkCounts.success > 0 || checkCounts.error > 0;
              // 仅当前 provider 在检查时，其禁用凭证才显示黄框（避免点单渠道 check 时其他渠道的禁用也变黄）
              const isInCheckMode = checkingCredentials || (checkingProvider !== null && checkingProvider === provider);

              return (
                <div key={provider} className={styles.providerGroup}>
                  <div className={styles.providerHeader} onClick={() => toggleProvider(provider)}>
                    <span className={styles.providerExpand}>{isExpanded ? '\u25BC' : '\u25B6'}</span>
                    <span className={styles.providerNameText}>{provider}</span>
                    <span className={styles.providerCount}>
                      {creds.length} {t('unified_routing.credentials_count', { defaultValue: '个凭证' })}
                      {addingModelsMode && selCount > 0 && (
                        <span className={styles.providerSelectedCount}>
                          ({selCount} {t('unified_routing.selected', { defaultValue: '已选' })})
                        </span>
                      )}
                    </span>
                    {hasCheckResults && (
                      <span className={styles.providerCheckResults}>
                        {checkCounts.success > 0 && (
                          <span className={styles.providerCheckBadgeSuccess} title="成功获取模型的凭证数">
                            {checkCounts.success}
                          </span>
                        )}
                        {checkCounts.error > 0 && (
                          <span className={styles.providerCheckBadgeError} title="获取模型失败的凭证数">
                            {checkCounts.error}
                          </span>
                        )}
                      </span>
                    )}
                    <div className={styles.providerActions} onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        className={styles.providerCheckBtn}
                        onClick={() => handleCheckProviderCredentials(provider)}
                        disabled={checkingCredentials || checkingProvider !== null}
                        title={t('unified_routing.check_provider_credentials', { defaultValue: '检查此凭证集合' })}
                      >
                        {checkingProvider === provider ? (
                          <LoadingSpinner size={8} />
                        ) : (
                          'check'
                        )}
                      </button>
                      {addingModelsMode && (
                        <label className={styles.selectAllLabel}>
                          <input
                            type="checkbox"
                            checked={isAllSelected}
                            onChange={() => handleSelectAllProvider(provider)}
                          />
                          {t('unified_routing.select_all', { defaultValue: '全选' })}
                        </label>
                      )}
                    </div>
                  </div>

                  {isExpanded && (
                    <div className={styles.providerBody}>
                      <div className={styles.credentialGrid}>
                        {pageCreds.map(cred => {
                          const isSelected = addingModelsMode && selectedCredentialIds.has(cred.id);
                          const checkStatus = credentialCheckStatus[cred.id];
                          const isDisabled = cred.status === 'disabled';
                          const cardClasses = [
                            styles.credentialCard,
                            isSelected && styles.credentialCardSelected,
                            !addingModelsMode && styles.credentialCardReadOnly,
                            !isDisabled && checkStatus === 'success' && styles.credentialCardSuccess,
                            !isDisabled && checkStatus === 'error' && styles.credentialCardError,
                            isDisabled && styles.credentialCardDisabled,
                            isDisabled && isInCheckMode && styles.credentialCardDisabledWithBorder,
                          ].filter(Boolean).join(' ');
                          return (
                            <div
                              key={cred.id}
                              className={cardClasses}
                              onClick={() => {
                                if (addingModelsMode) {
                                  toggleCredentialSelection(cred.id);
                                } else {
                                  openCredentialModelsModal(cred);
                                }
                              }}
                            >
                              {addingModelsMode && (
                                <input
                                  type="checkbox"
                                  className={styles.credentialCheckbox}
                                  checked={isSelected}
                                  readOnly
                                />
                              )}
                              <span className={styles.credentialLabel} title={cred.id}>
                                {getCredentialDisplayLabel(cred)}
                              </span>
                              {addingModelsMode && (
                                <button
                                  type="button"
                                  className={styles.credentialModelsBtn}
                                  onClick={(e) => { e.stopPropagation(); openCredentialModelsModal(cred); }}
                                  title={t('unified_routing.view_models', { defaultValue: '查看模型' })}
                                >
                                  <IconBot size={14} />
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                      {totalPages > 1 && (
                        <div className={styles.pagination}>
                          <Button variant="ghost" size="sm" disabled={page === 0}
                            onClick={() => setCredentialPage(p => ({ ...p, [provider]: page - 1 }))}>&lsaquo;</Button>
                          <span className={styles.pageInfo}>{page + 1} / {totalPages}</span>
                          <Button variant="ghost" size="sm" disabled={page >= totalPages - 1}
                            onClick={() => setCredentialPage(p => ({ ...p, [provider]: page + 1 }))}>&rsaquo;</Button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ===== Right: Models ===== */}
        <div className={styles.overviewRight}>
          <div className={styles.rightPanelHeader}>
            <span className={styles.rightPanelTitle}>
              {t('unified_routing.available_models', { defaultValue: '模型' })}
            </span>
          </div>
          <div className={styles.customModelInputRow}>
            <input
              type="text"
              className={styles.customModelInputField}
              placeholder={t('unified_routing.custom_model_placeholder', { defaultValue: '输入模型名称，回车添加' })}
              value={customModelInput}
              onChange={e => setCustomModelInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddCustomModel(); } }}
            />
          </div>
          <div className={styles.modelList}>
            {customModels.length > 0 ? (
              customModels.map(cm => {
                const isSelected = selectedModelIds.has(cm);
                return (
                  <div
                    key={`custom-${cm}`}
                    className={`${styles.modelCard} ${isSelected ? styles.modelCardSelected : ''}`}
                    onClick={() => addingModelsMode && toggleModelSelection(cm)}
                  >
                    {addingModelsMode && (
                      <input type="checkbox" className={styles.modelCheckbox} checked={isSelected} readOnly />
                    )}
                    <span className={styles.modelName} title={cm}>{cm}</span>
                    <button
                      type="button"
                      className={styles.removeCustomModelBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        setCustomModels(prev => prev.filter(x => x !== cm));
                        setSelectedModelIds(prev => { const n = new Set(prev); n.delete(cm); return n; });
                      }}
                      title="×"
                    >×</button>
                  </div>
                );
              })
            ) : (
              <div className={styles.noModels}>
                {t('unified_routing.no_models_hint', { defaultValue: '点击左侧凭证可浏览并添加模型' })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Batch Add Modal */}
      <Modal
        open={batchAddModalOpen}
        onClose={() => { setBatchAddModalOpen(false); setBatchAddTarget(null); }}
        title={t('unified_routing.batch_add_title', { defaultValue: '批量添加到路由层' })}
        width={640}
        footer={
          <>
            <Button variant="secondary" onClick={() => { setBatchAddModalOpen(false); setBatchAddTarget(null); }}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" onClick={handleBatchAddConfirm} disabled={!batchAddTarget}>
              {t('common.confirm', { defaultValue: '确认' })} ({validCombinationCount})
            </Button>
          </>
        }
      >
        <div className={styles.batchAddLayout}>
          <div className={styles.batchAddLeft}>
            <p className={styles.batchAddHint}>
              {t('unified_routing.batch_add_hint', { defaultValue: '将选中的凭证 × 模型组合添加到指定路由层', count: validCombinationCount })}
            </p>
            <div className={styles.routeLayerPicker}>
              {availableRoutes.map(({ route: r, pipeline: p }) => (
                <div key={r.id} className={styles.routeOption}>
                  <span className={styles.routeOptionName}>{r.name}</span>
                  <div className={styles.layerOptions}>
                    {p && p.layers.length > 0 ? (
                      [...p.layers].sort((a, b) => a.level - b.level).map((layer, idx) => (
                        <button key={layer.level} type="button"
                          className={`${styles.layerBtn} ${batchAddTarget?.routeId === r.id && batchAddTarget?.layerLevel === layer.level ? styles.layerBtnActive : ''}`}
                          onClick={() => setBatchAddTarget({ routeId: r.id, layerLevel: layer.level })}>
                          Layer {idx + 1}
                        </button>
                      ))
                    ) : (
                      <button type="button"
                        className={`${styles.layerBtn} ${batchAddTarget?.routeId === r.id && batchAddTarget?.layerLevel === 1 ? styles.layerBtnActive : ''}`}
                        onClick={() => setBatchAddTarget({ routeId: r.id, layerLevel: 1 })}>
                        Layer 1 ({t('unified_routing.new_layer', { defaultValue: '新建' })})
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {availableRoutes.length === 0 && (
                <div className={styles.noRoutes}>{t('unified_routing.no_routes_for_batch', { defaultValue: '没有可用路由' })}</div>
              )}
            </div>
          </div>
          <div className={styles.batchAddRight}>
            <div className={styles.batchAddSection}>
              <div className={styles.batchAddSectionTitle}>
                {t('unified_routing.credential', { defaultValue: '凭证' })} ({selectedCredentialIds.size})
              </div>
              {Object.entries(selectedCredsByProvider).map(([prov, cList]) => (
                <div key={prov} className={styles.batchAddGroup}>
                  <span className={styles.batchAddGroupName}>{prov}</span>
                  <div className={styles.batchAddTags}>
                    {cList.map(c => (
                      <span key={c.id} className={styles.batchAddTag} title={c.id}>{c.label || c.id}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <hr className={styles.batchAddDivider} />
            <div className={styles.batchAddSection}>
              <div className={styles.batchAddSectionTitle}>
                {t('unified_routing.available_models', { defaultValue: '模型' })} ({selectedModelsList.length})
              </div>
              <div className={styles.batchAddTags}>
                {selectedModelsList.map(mid => (
                  <span key={mid} className={styles.batchAddTag} title={mid}>{mid}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </Modal>

      {/* Credential models modal — with add buttons */}
      <Modal
        open={credentialModalCred !== null}
        onClose={closeCredentialModelsModal}
        title={credentialModalCred
          ? `${t('unified_routing.credential_models_modal_title', { defaultValue: '模型列表' })} - ${credentialModalCred.label || credentialModalCred.id}`
          : ''}
        width={480}
        footer={
          <Button variant="secondary" onClick={closeCredentialModelsModal}>{t('common.close')}</Button>
        }
      >
        {credentialModalLoading ? (
          <div className={styles.credentialModalLoading}>{t('common.loading')}</div>
        ) : (credentialModalModels?.length ?? 0) === 0 ? (
          <div className={styles.noModels}>{t('unified_routing.no_models', { defaultValue: '暂无模型' })}</div>
        ) : (
          <div className={styles.credentialModalModelsList}>
            {(credentialModalModels ?? []).map(model => {
              const modelId = model.name || model.id;
              const alreadyAdded = customModels.includes(modelId);
              return (
                <div key={model.id} className={styles.credentialModalModelRow}>
                  <span className={styles.credentialModalModelId}>{modelId}</span>
                  <button
                    type="button"
                    className={`${styles.credModalAddBtn} ${alreadyAdded ? styles.credModalAddBtnDone : ''}`}
                    onClick={() => handleAddModelFromModal(modelId)}
                    disabled={alreadyAdded}
                    title={alreadyAdded
                      ? t('unified_routing.model_already_added', { defaultValue: '已添加' })
                      : t('unified_routing.add_to_models', { defaultValue: '添加到模型' })}
                  >
                    {alreadyAdded ? '✓' : '+'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </Modal>
    </>
  );
});
