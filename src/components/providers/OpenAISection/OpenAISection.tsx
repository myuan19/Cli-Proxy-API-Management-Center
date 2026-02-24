import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { IconCheck, IconX } from '@/components/ui/icons';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import iconOpenaiLight from '@/assets/icons/openai-light.svg';
import iconOpenaiDark from '@/assets/icons/openai-dark.svg';
import type { OpenAIProviderConfig } from '@/types';
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
import { getOpenAIProviderStats, getStatsBySource } from '../utils';

interface ModelHealthResult {
  status: 'healthy' | 'unhealthy' | 'timeout' | 'checking';
  message?: string;
  latency_ms?: number;
}

interface OpenAISectionProps {
  configs: OpenAIProviderConfig[];
  keyStats: KeyStats;
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
  keyStats,
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

  const handleCheckAll = async () => {
    if (checkingAll) return;
    setCheckingAll(true);
    setHealthResults({});

    let healthy = 0;
    let unhealthy = 0;

    try {
      await providersApi.checkProvidersHealthStream(
        { type: 'openai-compatibility', timeout: 30 },
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
            setCheckingAll(false);
            const total = healthy + unhealthy;
            if (total > 0) {
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
      setCheckingAll(false);
    }
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
          renderContent={(item) => {
            const stats = getOpenAIProviderStats(item.apiKeyEntries, keyStats, item.prefix);
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
                      {apiKeyEntries.map((entry, entryIndex) => {
                        const entryStats = getStatsBySource(entry.apiKey, keyStats);
                        return (
                          <div key={entryIndex} className={styles.apiKeyEntryCard}>
                            <span className={styles.apiKeyEntryIndex}>{entryIndex + 1}</span>
                            <span className={styles.apiKeyEntryKey}>{maskApiKey(entry.apiKey)}</span>
                            {entry.proxyUrl && (
                              <span className={styles.apiKeyEntryProxy}>{entry.proxyUrl}</span>
                            )}
                            <div className={styles.apiKeyEntryStats}>
                              <span
                                className={`${styles.apiKeyEntryStat} ${styles.apiKeyEntryStatSuccess}`}
                              >
                                <IconCheck size={12} /> {entryStats.success}
                              </span>
                              <span
                                className={`${styles.apiKeyEntryStat} ${styles.apiKeyEntryStatFailure}`}
                              >
                                <IconX size={12} /> {entryStats.failure}
                              </span>
                            </div>
                          </div>
                        );
                      })}
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
                      const showChecking = checkingAll && !healthResult;
                      return (
                        <span
                          key={model.name}
                          className={`${styles.modelTag} ${
                            healthResult
                              ? healthResult.status === 'healthy'
                                ? styles.modelTagHealthy
                                : healthResult.status === 'timeout'
                                  ? styles.modelTagTimeout
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
                        </span>
                      );
                    })}
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
