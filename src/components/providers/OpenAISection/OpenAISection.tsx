import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import iconOpenaiLight from '@/assets/icons/openai-light.svg';
import iconOpenaiDark from '@/assets/icons/openai-dark.svg';
import type { OpenAIProviderConfig } from '@/types';
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

interface ModelHealthResult {
  status: 'healthy' | 'unhealthy' | 'timeout' | 'checking';
  message?: string;
  latency_ms?: number;
}

interface OpenAISectionProps {
  configs: OpenAIProviderConfig[];
  usageDetails: UsageDetail[];
  loading: boolean;
  disableControls: boolean;
  isSwitching: boolean;
  resolvedTheme: string;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
}

export function OpenAISection({
  configs,
  usageDetails,
  loading,
  disableControls,
  isSwitching,
  resolvedTheme,
  onAdd,
  onEdit,
  onDelete,
}: OpenAISectionProps) {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const actionsDisabled = disableControls || loading || isSwitching;

  const [healthResults, setHealthResults] = useState<Record<string, ModelHealthResult>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [checkingCards, setCheckingCards] = useState<Record<string, boolean>>({});

  const isAnyChecking = checkingAll || Object.values(checkingCards).some(Boolean);

  const runHealthCheck = async (opts: { name?: string; model?: string }) => {
    if (opts.name && !opts.model) {
      setCheckingCards((prev) => ({ ...prev, [opts.name!]: true }));
    }

    let healthy = 0;
    let unhealthy = 0;

    try {
      await providersApi.checkProvidersHealthStream(
        { type: 'openai-compatibility', timeout: 30, ...opts },
        {
          onResult: (item) => {
            const key = `${item.prefix || item.name}::${item.model_tested || ''}`;
            if (item.status === 'healthy') healthy++;
            else unhealthy++;
            setHealthResults((prev) => ({
              ...prev,
              [key]: {
                status:
                  item.status === 'healthy'
                    ? 'healthy'
                    : item.status === 'timeout'
                      ? 'timeout'
                      : 'unhealthy',
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
                  t('ai_providers.health_check_all_healthy', {
                    count: total,
                    defaultValue: `所有 ${total} 个模型健康`,
                  }),
                  'success'
                );
              } else if (healthy === 0) {
                showNotification(
                  t('ai_providers.health_check_all_unhealthy', {
                    count: total,
                    defaultValue: `所有 ${total} 个模型异常`,
                  }),
                  'error'
                );
              } else {
                showNotification(
                  t('ai_providers.health_check_result', {
                    healthy,
                    unhealthy,
                    defaultValue: `健康检查完成：${healthy} 个健康，${unhealthy} 个异常`,
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
      if (!opts.name) setCheckingAll(false);
      if (opts.name && !opts.model) setCheckingCards((prev) => ({ ...prev, [opts.name!]: false }));
    }
  };

  const handleCheckAll = async () => {
    if (isAnyChecking) return;
    setCheckingAll(true);
    setHealthResults({});
    await runHealthCheck({});
  };

  const handleCheckCard = async (providerName: string) => {
    if (isAnyChecking) return;
    await runHealthCheck({ name: providerName });
  };

  const handleCheckModel = async (providerName: string, modelName: string) => {
    if (isAnyChecking) return;
    setHealthResults((prev) => ({
      ...prev,
      [`${providerName}::${modelName}`]: { status: 'checking' },
    }));
    await runHealthCheck({ name: providerName, model: modelName });
  };

  const getModelResult = (
    provider: OpenAIProviderConfig,
    modelName: string
  ): ModelHealthResult | undefined => {
    const key = `${provider.prefix || provider.name}::${modelName}`;
    return healthResults[key];
  };

  const statusBarCache = useMemo(() => {
    const cache = new Map<string, ReturnType<typeof calculateStatusBarData>>();

    configs.forEach((provider) => {
      const sourceIds = new Set<string>();
      buildCandidateUsageSourceIds({ prefix: provider.prefix }).forEach((id) => sourceIds.add(id));
      (provider.apiKeyEntries || []).forEach((entry) => {
        buildCandidateUsageSourceIds({ apiKey: entry.apiKey }).forEach((id) => sourceIds.add(id));
      });

      const filteredDetails = sourceIds.size
        ? usageDetails.filter((detail) => sourceIds.has(detail.source))
        : [];
      cache.set(provider.name, calculateStatusBarData(filteredDetails));
    });

    return cache;
  }, [configs, usageDetails]);

  return (
    <>
      <Card
        title={
          <span className={styles.cardTitle}>
            <img
              src={resolvedTheme === 'dark' ? iconOpenaiDark : iconOpenaiLight}
              alt=""
              className={styles.cardTitleIcon}
            />
            {t('ai_providers.openai_title')}
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
              {checkingAll ? (
                <LoadingSpinner size={14} />
              ) : (
                t('ai_providers.health_check_all', { defaultValue: '全部检查' })
              )}
            </Button>
            <Button size="sm" onClick={onAdd} disabled={actionsDisabled}>
              {t('ai_providers.openai_add_button')}
            </Button>
          </div>
        }
      >
        <ProviderList<OpenAIProviderConfig>
          items={configs}
          loading={loading}
          keyField={(_, index) => `openai-provider-${index}`}
          emptyTitle={t('ai_providers.openai_empty_title')}
          emptyDescription={t('ai_providers.openai_empty_desc')}
          onEdit={onEdit}
          onDelete={onDelete}
          actionsDisabled={actionsDisabled}
          renderExtraActions={(item) => (
            <Button
              variant="secondary"
              size="sm"
              className={styles.providerHealthCheckButton}
              onClick={() => void handleCheckCard(item.name)}
              disabled={actionsDisabled || isAnyChecking}
            >
              {checkingCards[item.name] ? (
                <LoadingSpinner size={14} />
              ) : (
                t('ai_providers.health_check_card', { defaultValue: '检查' })
              )}
            </Button>
          )}
          renderContent={(item) => {
            const headerEntries = Object.entries(item.headers || {});
            const apiKeyEntries = item.apiKeyEntries || [];
            const statusData = statusBarCache.get(item.name) || calculateStatusBarData([]);

            return (
              <Fragment>
                <div className="item-title">{item.name}</div>
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
                <div className={styles.fieldRow}>
                  <span className={styles.fieldLabel}>{t('common.base_url')}:</span>
                  <span className={styles.fieldValue}>{item.baseUrl}</span>
                </div>
                {headerEntries.length > 0 && (
                  <div className={styles.headerBadgeList}>
                    {headerEntries.map(([key, value]) => (
                      <span key={key} className={styles.headerBadge}>
                        <strong>{key}:</strong> {value}
                      </span>
                    ))}
                  </div>
                )}
                {apiKeyEntries.length > 0 && (
                  <div className={styles.apiKeyEntriesSection}>
                    <div className={styles.apiKeyEntriesLabel}>
                      {t('ai_providers.openai_keys_count')}: {apiKeyEntries.length}
                    </div>
                    <div className={styles.apiKeyEntryList}>
                      {apiKeyEntries.map((entry, entryIndex) => (
                          <div key={entryIndex} className={styles.apiKeyEntryCard}>
                            <span className={styles.apiKeyEntryIndex}>{entryIndex + 1}</span>
                            <span className={styles.apiKeyEntryKey}>{maskApiKey(entry.apiKey)}</span>
                            {entry.proxyUrl && (
                              <span className={styles.apiKeyEntryProxy}>{entry.proxyUrl}</span>
                            )}
                          </div>
                      ))}
                    </div>
                  </div>
                )}
                <div className={styles.fieldRow} style={{ marginTop: '8px' }}>
                  <span className={styles.fieldLabel}>{t('ai_providers.openai_models_count')}:</span>
                  <span className={styles.fieldValue}>{item.models?.length || 0}</span>
                </div>
                {item.models?.length ? (
                  <div className={styles.modelTagList}>
                    {item.models.map((model) => {
                      const healthResult = getModelResult(item, model.name);
                      const showChecking = (checkingAll || checkingCards[item.name]) && !healthResult;
                      const isModelChecking = healthResult?.status === 'checking';
                      return (
                        <button
                          type="button"
                          key={model.name}
                          className={`${styles.modelTag} ${
                            healthResult && healthResult.status !== 'checking'
                              ? healthResult.status === 'healthy'
                                ? styles.modelTagHealthy
                                : healthResult.status === 'timeout'
                                  ? styles.modelTagTimeout
                                  : styles.modelTagUnhealthy
                              : ''
                          }`}
                          onClick={() => void handleCheckModel(item.name, model.name)}
                          disabled={isAnyChecking || isModelChecking}
                          title={t('ai_providers.health_check_model', { defaultValue: '点击检查此模型' })}
                        >
                          <span className={styles.modelName}>{model.name}</span>
                          {model.alias && model.alias !== model.name && (
                            <span className={styles.modelAlias}>{model.alias}</span>
                          )}
                          {(showChecking || isModelChecking) && <LoadingSpinner size={12} />}
                          {healthResult && healthResult.status !== 'checking' && (
                            <span
                              className={
                                healthResult.status === 'healthy'
                                  ? styles.modelHealthBadge
                                  : healthResult.status === 'timeout'
                                    ? styles.modelHealthBadgeTimeout
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
                <ProviderStatusBar statusData={statusData} />
              </Fragment>
            );
          }}
        />
      </Card>
    </>
  );
}
