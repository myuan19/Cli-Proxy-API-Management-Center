import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import iconClaude from '@/assets/icons/claude.svg';
import type { ProviderKeyConfig } from '@/types';
import { maskApiKey } from '@/utils/format';
import {
  buildCandidateUsageSourceIds,
  calculateStatusBarData,
  type UsageDetail,
} from '@/utils/usage';
import { providersApi } from '@/services/api';
import { useNotificationStore } from '@/stores';
import styles from '@/pages/AiProvidersPage.module.scss';
import { ProviderList } from '../ProviderList';
import { ProviderStatusBar } from '../ProviderStatusBar';
import { hasDisableAllModelsRule } from '../utils';

interface ModelHealthResult {
  status: 'healthy' | 'unhealthy' | 'timeout' | 'checking';
  message?: string;
  latency_ms?: number;
}

interface ClaudeSectionProps {
  configs: ProviderKeyConfig[];
  usageDetails: UsageDetail[];
  loading: boolean;
  disableControls: boolean;
  isSwitching: boolean;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onToggle: (index: number, enabled: boolean) => void;
}

export function ClaudeSection({
  configs,
  usageDetails,
  loading,
  disableControls,
  isSwitching,
  onAdd,
  onEdit,
  onDelete,
  onToggle,
}: ClaudeSectionProps) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const actionsDisabled = disableControls || loading || isSwitching;
  const toggleDisabled = disableControls || loading || isSwitching;

  // modelId (from SSE result) -> result
  const [healthResults, setHealthResults] = useState<Record<string, ModelHealthResult>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const isAnyChecking = checkingAll;

  const runHealthCheck = async (opts: { model?: string }) => {
    let healthy = 0;
    let unhealthy = 0;

    try {
      await providersApi.checkProvidersHealthStream(
        { type: 'claude-api-key', timeout: 30, ...opts },
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
            const total = healthy + unhealthy;
            if (total > 0 && !opts.model) {
              if (unhealthy === 0) {
                showNotification(
                  t('ai_providers.health_check_all_healthy', { count: total, defaultValue: `全部 ${total} 个模型健康` }),
                  'success'
                );
              } else if (healthy === 0) {
                showNotification(
                  t('ai_providers.health_check_all_unhealthy', { count: total, defaultValue: `全部 ${total} 个模型异常` }),
                  'error'
                );
              } else {
                showNotification(
                  t('ai_providers.health_check_result', {
                    healthy,
                    unhealthy,
                    defaultValue: `${healthy} 个健康，${unhealthy} 个异常`,
                  }),
                  'warning'
                );
              }
            }
          },
        }
      );
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      showNotification(
        `${t('ai_providers.health_check_failed', { defaultValue: '健康检查失败' })}: ${errorMessage}`,
        'error'
      );
    } finally {
      setCheckingAll(false);
    }
  };

  const handleCheckAll = async () => {
    if (isAnyChecking) return;
    setCheckingAll(true);
    setHealthResults({});
    await runHealthCheck({});
  };

  const handleCheckModel = async (modelName: string) => {
    if (isAnyChecking) return;
    setHealthResults((prev) => {
      const next = { ...prev };
      configs.forEach((cfg) => {
        next[`${cfg.prefix || 'claude'}::${modelName}`] = { status: 'checking' };
      });
      return next;
    });
    await runHealthCheck({ model: modelName });
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

  const getModelResult = (cfg: ProviderKeyConfig, modelName: string): ModelHealthResult | undefined => {
    const key = `${cfg.prefix || 'claude'}::${modelName}`;
    return healthResults[key];
  };

  return (
    <>
      <Card
        title={
          <span className={styles.cardTitle}>
            <img src={iconClaude} alt="" className={styles.cardTitleIcon} />
            {t('ai_providers.claude_title')}
          </span>
        }
        extra={
          <div className={styles.cardHeaderActions}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void handleCheckAll()}
              disabled={actionsDisabled || isAnyChecking || configs.length === 0}
            >
              {checkingAll ? <LoadingSpinner size={14} /> : t('ai_providers.health_check_all', { defaultValue: '全部检查' })}
            </Button>
            <Button size="sm" onClick={onAdd} disabled={actionsDisabled}>
              {t('ai_providers.claude_add_button')}
            </Button>
          </div>
        }
      >
        <ProviderList<ProviderKeyConfig>
          items={configs}
          loading={loading}
          keyField={(item) => item.apiKey}
          emptyTitle={t('ai_providers.claude_empty_title')}
          emptyDescription={t('ai_providers.claude_empty_desc')}
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
            const headerEntries = Object.entries(item.headers || {});
            const configDisabled = hasDisableAllModelsRule(item.excludedModels);
            const excludedModels = item.excludedModels ?? [];
            const statusData = statusBarCache.get(item.apiKey) || calculateStatusBarData([]);

            return (
              <Fragment>
                <div className="item-title">{t('ai_providers.claude_item_title')}</div>
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
                {item.cloak && (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('ai_providers.claude_cloak_mode_label')}:</span>
                    <span className={styles.fieldValue}>
                      {(() => {
                        const raw = (item.cloak?.mode ?? '').trim().toLowerCase();
                        const key = raw === 'always' || raw === 'never' ? raw : 'auto';
                        return t(`ai_providers.claude_cloak_mode_${key}`);
                      })()}
                    </span>
                  </div>
                )}
                {item.cloak?.strictMode ? (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>{t('ai_providers.claude_cloak_strict_label')}:</span>
                    <span className={styles.fieldValue}>{t('common.yes')}</span>
                  </div>
                ) : null}
                {item.cloak?.sensitiveWords?.length ? (
                  <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>
                      {t('ai_providers.claude_cloak_sensitive_words_count')}:
                    </span>
                    <span className={styles.fieldValue}>{item.cloak.sensitiveWords.length}</span>
                  </div>
                ) : null}
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
                      {t('ai_providers.claude_models_count')}: {item.models.length}
                    </span>
                    {item.models.map((model) => {
                      const healthResult = getModelResult(item, model.name);
                      const showChecking = checkingAll && !healthResult;
                      return (
                        <button
                          type="button"
                          key={model.name}
                          className={`${styles.modelTag} ${
                            healthResult && healthResult.status !== 'checking'
                              ? healthResult.status === 'healthy'
                                ? styles.modelTagHealthy
                                : styles.modelTagUnhealthy
                              : ''
                          }`}
                          onClick={() => void handleCheckModel(model.name)}
                          disabled={isAnyChecking || healthResult?.status === 'checking'}
                          title={t('ai_providers.health_check_model', { defaultValue: '点击检查此模型' })}
                        >
                          <span className={styles.modelName}>{model.name}</span>
                          {model.alias && model.alias !== model.name && (
                            <span className={styles.modelAlias}>{model.alias}</span>
                          )}
                          {(showChecking || healthResult?.status === 'checking') && <LoadingSpinner size={12} />}
                          {healthResult && healthResult.status !== 'checking' && (
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
                        </button>
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
                <ProviderStatusBar statusData={statusData} />
              </Fragment>
            );
          }}
        />
      </Card>
    </>
  );
}
