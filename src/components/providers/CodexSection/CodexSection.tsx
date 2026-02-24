import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import iconCodexLight from '@/assets/icons/codex_light.svg';
import iconCodexDark from '@/assets/icons/codex_drak.svg';
import type { ProviderKeyConfig } from '@/types';
import { maskApiKey } from '@/utils/format';
import {
  buildCandidateUsageSourceIds,
  calculateStatusBarData,
  type KeyStats,
  type UsageDetail,
} from '@/utils/usage';
import { providersApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import styles from '@/pages/AiProvidersPage.module.scss';
import { ProviderList } from '../ProviderList';
import { ProviderStatusBar } from '../ProviderStatusBar';
import { getStatsBySource, hasDisableAllModelsRule } from '../utils';

interface ModelHealthResult {
  status: 'healthy' | 'unhealthy' | 'timeout' | 'checking';
  message?: string;
  latency_ms?: number;
}

interface CodexSectionProps {
  configs: ProviderKeyConfig[];
  keyStats: KeyStats;
  usageDetails: UsageDetail[];
  loading: boolean;
  disableControls: boolean;
  isSwitching: boolean;
  resolvedTheme: string;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onToggle: (index: number, enabled: boolean) => void;
}

export function CodexSection({
  configs,
  keyStats,
  usageDetails,
  loading,
  disableControls,
  isSwitching,
  resolvedTheme,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
}: CodexSectionProps) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const actionsDisabled = disableControls || loading || isSwitching;
  const toggleDisabled = disableControls || loading || isSwitching;

  const [healthResults, setHealthResults] = useState<Record<string, ModelHealthResult>>({});
  const [checkingAll, setCheckingAll] = useState(false);

  const handleCheckAll = async () => {
    if (checkingAll) return;
    setCheckingAll(true);
    setHealthResults({});

    let healthy = 0;
    let unhealthy = 0;

    try {
      await providersApi.checkProvidersHealthStream(
        { type: 'codex-api-key', timeout: 30 },
        {
          onResult: (item) => {
            const key = `${item.prefix || item.name}::${item.model_tested || ''}`;
            if (item.status === 'healthy') healthy++;
            else unhealthy++;
            setHealthResults((prev) => ({
              ...prev,
              [key]: {
                status: item.status === 'healthy' ? 'healthy' : item.status === 'timeout' ? 'timeout' : 'unhealthy',
                message: item.message,
                latency_ms: item.latency_ms,
              },
            }));
          },
          onDone: () => {
            setCheckingAll(false);
            const total = healthy + unhealthy;
            if (total === 0) return;
            if (unhealthy === 0) {
              showNotification(t('ai_providers.health_check_all_healthy', { count: total, defaultValue: `全部 ${total} 个模型健康` }), 'success');
            } else if (healthy === 0) {
              showNotification(t('ai_providers.health_check_all_unhealthy', { count: total, defaultValue: `全部 ${total} 个模型异常` }), 'error');
            } else {
              showNotification(t('ai_providers.health_check_result', { healthy, unhealthy, defaultValue: `${healthy} 个健康，${unhealthy} 个异常` }), 'warning');
            }
          },
        }
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      showNotification(`${t('ai_providers.health_check_failed', { defaultValue: '健康检查失败' })}: ${errorMessage}`, 'error');
    } finally {
      setCheckingAll(false);
    }
  };

  const getModelResult = (cfg: ProviderKeyConfig, modelName: string): ModelHealthResult | undefined => {
    const key = `${cfg.prefix || 'codex'}::${modelName}`;
    return healthResults[key];
  };

  const statusBarCache = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof calculateStatusBarData>>();

    configs.forEach((config) => {
      if (!config.apiKey) return;
      const candidates = buildCandidateUsageSourceIds({
        apiKey: config.apiKey,
        prefix: config.prefix,
      });
      if (!candidates.length) return;
      const candidateSet = new Set(candidates);
      const filteredDetails = usageDetails.filter((detail) => candidateSet.has(detail.source));
      cache.set(config.apiKey, calculateStatusBarData(filteredDetails));
    });

    return cache;
  }, [configs, usageDetails]);

  return (
    <>
      <Card
        title={
          <span className={styles.cardTitle}>
            <img
              src={resolvedTheme === 'dark' ? iconCodexDark : iconCodexLight}
              alt=""
              className={styles.cardTitleIcon}
            />
            {t('ai_providers.codex_title')}
          </span>
        }
        extra={
          <div className={styles.cardHeaderActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCheckAll()}
              disabled={actionsDisabled || checkingAll || configs.length === 0}
            >
              {checkingAll ? <LoadingSpinner size={14} /> : t('ai_providers.health_check_all', { defaultValue: '全部检查' })}
            </Button>
            <Button size="sm" onClick={onAdd} disabled={actionsDisabled}>
              {t('ai_providers.codex_add_button')}
            </Button>
          </div>
        }
      >
        <ProviderList<ProviderKeyConfig>
          items={configs}
          loading={loading}
          keyField={(item) => item.apiKey}
          emptyTitle={t('ai_providers.codex_empty_title')}
          emptyDescription={t('ai_providers.codex_empty_desc')}
          onEdit={onEdit}
          onDelete={onDelete}
          actionsDisabled={actionsDisabled}
          getRowDisabled={(item) => hasDisableAllModelsRule(item.excludedModels)}
          renderExtraActions={(item, index) => (
            <ToggleSwitch
              label={t('ai_providers.config_toggle_label')}
              checked={!hasDisableAllModelsRule(item.excludedModels)}
              disabled={toggleDisabled}
              onChange={(value) => void onToggle(index, value)}
            />
          )}
          renderContent={(item) => {
            const stats = getStatsBySource(item.apiKey, keyStats, item.prefix);
            const headerEntries = Object.entries(item.headers || {});
            const configDisabled = hasDisableAllModelsRule(item.excludedModels);
            const excludedModels = item.excludedModels ?? [];
            const statusData = statusBarCache.get(item.apiKey) || calculateStatusBarData([]);

            return (
              <Fragment>
                <div className="item-title">{t('ai_providers.codex_item_title')}</div>
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>{t('common.api_key')}:</span>
                  <span className={styles.fieldValue}>{maskApiKey(item.apiKey)}</span>
                </div>
                {item.priority !== undefined && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('common.priority')}:</span>
                    <span className={styles.fieldValue}>{item.priority}</span>
                  </div>
                )}
                {item.prefix && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('common.prefix')}:</span>
                    <span className={styles.fieldValue}>{item.prefix}</span>
                  </div>
                )}
                {item.baseUrl && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('common.base_url')}:</span>
                    <span className={styles.fieldValue}>{item.baseUrl}</span>
                  </div>
                )}
                {item.proxyUrl && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('common.proxy_url')}:</span>
                    <span className={styles.fieldValue}>{item.proxyUrl}</span>
                  </div>
                )}
                {item.websockets !== undefined && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('ai_providers.codex_websockets_label')}:</span>
                    <span className={styles.fieldValue}>{item.websockets ? t('common.yes') : t('common.no')}</span>
                  </div>
                )}
                {headerEntries.length > 0 && (
                  <div className={styles.headerBadgeList}>
                    {headerEntries.map(([key, value]) => (
                      <span key={key} className={styles.headerBadge}>
                        <strong>{key}:</strong> {value}
                      </span>
                    ))}
                  </div>
                )}
                {configDisabled && (
                  <div className="status-badge warning" style={{ marginTop: 8, marginBottom: 0 }}>
                    {t('ai_providers.config_disabled_badge')}
                  </div>
                )}
                {item.models?.length ? (
                  <div className={styles.modelTagList}>
                    <span className={styles.modelCountLabel}>
                      {t('ai_providers.codex_models_count')}: {item.models.length}
                    </span>
                    {item.models.map((model) => {
                      const healthResult = getModelResult(item, model.name);
                      const showChecking = checkingAll && !healthResult;
                      return (
                        <span
                          key={model.name}
                          className={`${styles.modelTag} ${
                            healthResult
                              ? healthResult.status === 'healthy'
                                ? styles.modelTagHealthy
                                : styles.modelTagUnhealthy
                              : ''
                          }`}
                        >
                          <span className={styles.modelName}>{model.name}</span>
                          {model.alias && model.alias !== model.name && (
                            <span className={styles.modelAlias}>{model.alias}</span>
                          )}
                          {showChecking && <LoadingSpinner size={12} />}
                          {healthResult && (
                            <span
                              className={
                                healthResult.status === 'healthy'
                                  ? styles.modelHealthBadge
                                  : styles.modelHealthBadgeUnhealthy
                              }
                              title={healthResult.message || ''}
                            >
                              {healthResult.status === 'healthy'
                                ? healthResult.latency_ms
                                  ? `${healthResult.latency_ms}ms`
                                  : '✓'
                                : healthResult.status === 'timeout'
                                  ? '⏱'
                                  : '✗'}
                            </span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                ) : null}
                {excludedModels.length ? (
                  <div className={styles.excludedModelsSection}>
                    <div className={styles.excludedModelsLabel}>
                      {t('ai_providers.excluded_models_count', { count: excludedModels.length })}
                    </div>
                    <div className={styles.modelTagList}>
                      {excludedModels.map((model) => (
                        <span key={model} className={`${styles.modelTag} ${styles.excludedModelTag}`}>
                          <span className={styles.modelName}>{model}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className={styles.cardStats}>
                  <span className={`${styles.statPill} ${styles.statSuccess}`}>
                    {t('stats.success')}: {stats.success}
                  </span>
                  <span className={`${styles.statPill} ${styles.statFailure}`}>
                    {t('stats.failure')}: {stats.failure}
                  </span>
                </div>
                <ProviderStatusBar statusData={statusData} />
              </Fragment>
            );
          }}
        />
      </Card>
    </>
  );
}
