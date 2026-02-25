/**
 * Credentials Overview Component
 * Left (2/3): providers with credential cards (2×3 grid, paginated).
 * Right (1/3): models panel — custom models (input + list) separated by divider from fetched models.
 * "添加模型" global toggle controls selection mode.
 * "检查凭证" button: concurrency-10 fetch models per credential, green/red status.
 * Non-adding mode: clicking a credential card opens its models modal.
 * Adding mode: bot icon button on each card opens models modal.
 * Re-fetching models preserves previously selected models by migrating them to custom list.
 * Switching provider clears model selection.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { IconBot } from '@/components/ui/icons';
import { unifiedRoutingApi } from '@/services/api/unifiedRouting';
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
}

interface ProviderModelsState {
  models: { credentialId: string; modelId: string; modelName: string }[];
  loading: boolean;
  loaded: boolean;
}

export function CredentialsOverview({
  credentials,
  loading,
  routes,
  routePipelines,
  onPipelineChange,
}: CredentialsOverviewProps) {
  const { t } = useTranslation();

  const [expandedProviders, setExpandedProviders] = useState<Set<string>>(new Set());
  const [credentialPage, setCredentialPage] = useState<Record<string, number>>({});
  const [addingModelsMode, setAddingModelsMode] = useState(false);
  const [selectedCredentialIds, setSelectedCredentialIds] = useState<Set<string>>(new Set());
  const [providerModels, setProviderModels] = useState<Record<string, ProviderModelsState>>({});
  const [modelsPanelProvider, setModelsPanelProvider] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [batchAddModalOpen, setBatchAddModalOpen] = useState(false);
  const [batchAddTarget, setBatchAddTarget] = useState<{ routeId: string; layerLevel: number } | null>(null);
  const [customModels, setCustomModels] = useState<string[]>([]);
  const [customModelInput, setCustomModelInput] = useState('');

  const [credentialCheckStatus, setCredentialCheckStatus] = useState<Record<string, 'success' | 'error'>>({});
  const [checkingCredentials, setCheckingCredentials] = useState(false);

  const [credentialModalCred, setCredentialModalCred] = useState<CredentialInfo | null>(null);
  const [credentialModalModels, setCredentialModalModels] = useState<ModelInfo[] | null>(null);
  const [credentialModalLoading, setCredentialModalLoading] = useState(false);

  const groupedCredentials = useMemo(() => {
    const groups: Record<string, CredentialInfo[]> = {};
    for (const cred of credentials) {
      if (cred.status === 'disabled') continue;
      const key = cred.provider;
      if (!groups[key]) groups[key] = [];
      groups[key].push(cred);
    }
    return groups;
  }, [credentials]);

  const providers = useMemo(() => Object.keys(groupedCredentials).sort(), [groupedCredentials]);

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

  // ========== Fetch models for provider ==========
  const fetchModelsForProvider = useCallback(async (provider: string) => {
    const creds = groupedCredentials[provider];
    if (!creds?.length) return;

    setProviderModels(prev => ({
      ...prev,
      [provider]: { ...(prev[provider] || { models: [], loaded: false }), loading: true },
    }));

    try {
      const list = await unifiedRoutingApi.listCredentials({ provider });
      const allModels: { credentialId: string; modelId: string; modelName: string }[] = [];
      const seen = new Set<string>();
      for (const cred of list.credentials.filter(c => c.status !== 'disabled')) {
        for (const m of cred.models) {
          const key = `${cred.id}:${m.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            allModels.push({ credentialId: cred.id, modelId: m.id, modelName: m.name });
          }
        }
      }

      const newFetchedIds = new Set(allModels.map(m => m.modelId));

      // Re-fetch or switch: migrate selected models that disappear from panel to custom
      if (modelsPanelProvider != null) {
        const oldState = providerModels[modelsPanelProvider];
        const oldFetchedIds = new Set((oldState?.models ?? []).map(m => m.modelId));
        const selectedCleared: string[] = [];
        for (const oid of oldFetchedIds) {
          if (!newFetchedIds.has(oid) && selectedModelIds.has(oid)) {
            selectedCleared.push(oid);
          }
        }
        if (selectedCleared.length > 0) {
          setCustomModels(prev => {
            const next = [...prev];
            for (const mid of selectedCleared) {
              if (!next.includes(mid)) next.push(mid);
            }
            return next;
          });
        }
      }

      setProviderModels(prev => ({
        ...prev,
        [provider]: { models: allModels, loading: false, loaded: true },
      }));
      if (allModels.length > 0) setModelsPanelProvider(provider);

      // Remove from custom any model that now appears in fetched (deduplicate at source)
      setCustomModels(prev => prev.filter(id => !newFetchedIds.has(id)));
    } catch {
      setProviderModels(prev => ({
        ...prev,
        [provider]: { ...(prev[provider] || { models: [], loaded: false }), loading: false, loaded: true },
      }));
    }
  }, [groupedCredentials, modelsPanelProvider, selectedModelIds, providerModels]);

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

  const toggleModelSelection = useCallback((modelId: string) => {
    setSelectedModelIds(prev => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }, []);

  // ========== Right panel models: separate custom and fetched ==========
  const fetchedModels = useMemo(() => {
    if (!modelsPanelProvider) return [];
    const state = providerModels[modelsPanelProvider];
    if (!state?.models?.length) return [];
    const byId = new Map<string, string>();
    for (const m of state.models) {
      if (!byId.has(m.modelId)) byId.set(m.modelId, m.modelName);
    }
    return Array.from(byId.entries()).map(([id, name]) => ({ id, name }));
  }, [modelsPanelProvider, providerModels]);

  const customModelsFiltered = useMemo(() => {
    const fetchedIds = new Set(fetchedModels.map(m => m.id));
    return customModels.filter(cm => !fetchedIds.has(cm));
  }, [customModels, fetchedModels]);

  const validCombinationCount = useMemo(() => {
    if (selectedCredentialIds.size === 0 || selectedModelIds.size === 0) return 0;
    return selectedCredentialIds.size * selectedModelIds.size;
  }, [selectedCredentialIds, selectedModelIds]);

  const handleAddCustomModel = useCallback(() => {
    const trimmed = customModelInput.trim();
    if (!trimmed) return;
    setCustomModels(prev => prev.includes(trimmed) ? prev : [...prev, trimmed]);
    setCustomModelInput('');
  }, [customModelInput]);

  const handleBatchAdd = useCallback(() => {
    if (validCombinationCount === 0) return;
    setBatchAddModalOpen(true);
  }, [validCombinationCount]);

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

  // ========== Batch add modal: selected credentials grouped by provider ==========
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

  const selectedModelsList = useMemo(() => {
    return [...selectedModelIds];
  }, [selectedModelIds]);

  // ========== Title summary ==========
  const totalCredCount = credentials.filter(c => c.status !== 'disabled').length;
  const titleSummary = useMemo(() => {
    const base = t('unified_routing.credentials_overview');
    if (!addingModelsMode) return base;
    return (
      <>
        {base}
        <span className={styles.titleCredHint}>
          {totalCredCount} {t('unified_routing.credentials_count', { defaultValue: '个凭证' })}
        </span>
      </>
    );
  }, [t, addingModelsMode, totalCredCount]);

  if (loading) {
    return (
      <Card title={t('unified_routing.credentials_overview')} className={styles.card}>
        <div className={styles.loading}>{t('common.loading')}</div>
      </Card>
    );
  }

  if (credentials.length === 0) {
    return (
      <Card title={t('unified_routing.credentials_overview')} className={styles.card}>
        <div className={styles.empty}>{t('unified_routing.no_credentials')}</div>
      </Card>
    );
  }

  return (
    <Card
      title={titleSummary}
      className={styles.card}
      extra={
        <div className={styles.topActions}>
          {addingModelsMode && (
            <span className={styles.topCounts}>
              {selectedCredentialIds.size} | {selectedModelIds.size}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCheckAllCredentials}
            disabled={checkingCredentials}
          >
            {checkingCredentials
              ? t('common.loading')
              : t('unified_routing.check_credentials', { defaultValue: '检查凭证' })}
          </Button>
          {addingModelsMode && validCombinationCount > 0 && (
            <Button variant="primary" size="sm" onClick={handleBatchAdd}>
              {t('unified_routing.batch_add', { defaultValue: '批量添加' })} ({validCombinationCount})
            </Button>
          )}
          <button
            type="button"
            className={`${styles.addModelsToggle} ${addingModelsMode ? styles.addModelsToggleActive : ''}`}
            onClick={() => setAddingModelsMode(prev => !prev)}
          >
            <span className={styles.addModelsCheck}>{addingModelsMode ? '\u2713' : ''}</span>
            {addingModelsMode
              ? t('unified_routing.cancel', { defaultValue: '取消' })
              : t('unified_routing.add_models', { defaultValue: '添加模型' })}
          </button>
        </div>
      }
    >
      <div className={styles.overviewLayout}>
        <div className={styles.overviewLeft}>
          <div className={styles.providerList}>
            {providers.map(provider => {
              const isExpanded = expandedProviders.has(provider);
              const creds = groupedCredentials[provider];
              const page = credentialPage[provider] ?? 0;
              const totalPages = totalCredPages(provider);
              const pageCreds = credsForProviderPage(provider, page);
              const modelsState = providerModels[provider];
              const isAllSelected = isProviderAllSelected(provider);
              const selCount = selectedCountForProvider(provider);

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
                    <div className={styles.providerActions} onClick={e => e.stopPropagation()}>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => fetchModelsForProvider(provider)}
                        disabled={modelsState?.loading}
                      >
                        {modelsState?.loading
                          ? t('common.loading')
                          : t('unified_routing.fetch_models', { defaultValue: '获取模型' })}
                      </Button>
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
                          return (
                            <div
                              key={cred.id}
                              className={`${styles.credentialCard} ${isSelected ? styles.credentialCardSelected : ''} ${!addingModelsMode ? styles.credentialCardReadOnly : ''} ${checkStatus === 'success' ? styles.credentialCardSuccess : ''} ${checkStatus === 'error' ? styles.credentialCardError : ''}`}
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
                                {cred.label || cred.id}
                              </span>
                              {addingModelsMode && (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className={styles.credentialModelsBtn}
                                  onClick={(e) => { e.stopPropagation(); openCredentialModelsModal(cred); }}
                                  title={t('unified_routing.view_models', { defaultValue: '查看模型' })}
                                >
                                  <IconBot size={14} />
                                </Button>
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

        <div className={styles.overviewRight}>
          <div className={styles.rightPanelHeader}>
            <span className={styles.rightPanelTitle}>
              {modelsPanelProvider
                ? `${t('unified_routing.available_models')} · ${modelsPanelProvider}`
                : t('unified_routing.available_models')}
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
            {/* Custom models section */}
            {customModelsFiltered.length > 0 && (
              <>
                {customModelsFiltered.map(cm => {
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
                })}
                {fetchedModels.length > 0 && <hr className={styles.modelDivider} />}
              </>
            )}
            {/* Fetched models section */}
            {fetchedModels.length > 0 ? (
              fetchedModels.map(({ id, name }) => {
                const isSelected = selectedModelIds.has(id);
                return (
                  <div
                    key={id}
                    className={`${styles.modelCard} ${isSelected ? styles.modelCardSelected : ''}`}
                    onClick={() => addingModelsMode && toggleModelSelection(id)}
                  >
                    {addingModelsMode && (
                      <input type="checkbox" className={styles.modelCheckbox} checked={isSelected} readOnly />
                    )}
                    <span className={styles.modelName} title={id}>{name || id}</span>
                  </div>
                );
              })
            ) : customModelsFiltered.length === 0 ? (
              <div className={styles.noModels}>
                {t('unified_routing.no_models', { defaultValue: '暂无模型' })}
              </div>
            ) : null}
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

      {/* Credential models modal */}
      <Modal
        open={credentialModalCred !== null}
        onClose={closeCredentialModelsModal}
        title={credentialModalCred
          ? `${t('unified_routing.credential_models_modal_title', { defaultValue: '模型列表' })} - ${credentialModalCred.label || credentialModalCred.id}`
          : ''}
        width={420}
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
            {(credentialModalModels ?? []).map(model => (
              <div key={model.id} className={styles.credentialModalModelRow}>
                <span className={styles.credentialModalModelId}>{model.name || model.id}</span>
              </div>
            ))}
          </div>
        )}
      </Modal>
    </Card>
  );
}
