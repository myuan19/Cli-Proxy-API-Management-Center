import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  AmpcodeSection,
  ClaudeSection,
  CodexSection,
  GeminiSection,
  OpenAISection,
  VertexSection,
  ProviderNav,
  useProviderStats,
} from '@/components/providers';
import {
  withDisableAllModelsRule,
  withoutDisableAllModelsRule,
} from '@/components/providers/utils';
import { ampcodeApi, authFilesApi, providersApi } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore, useThemeStore } from '@/stores';
import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import styles from './AiProvidersPage.module.scss';

export function AiProvidersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { showNotification, showConfirmation } = useNotificationStore();
  const resolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);

  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);
  const clearCache = useConfigStore((state) => state.clearCache);
  const isCacheValid = useConfigStore((state) => state.isCacheValid);

  const hasMounted = useRef(false);
  const [loading, setLoading] = useState(() => !isCacheValid());
  const [error, setError] = useState('');

  const [geminiKeys, setGeminiKeys] = useState<GeminiKeyConfig[]>(
    () => config?.geminiApiKeys || []
  );
  const [codexConfigs, setCodexConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.codexApiKeys || []
  );
  const [claudeConfigs, setClaudeConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.claudeApiKeys || []
  );
  const [vertexConfigs, setVertexConfigs] = useState<ProviderKeyConfig[]>(
    () => config?.vertexApiKeys || []
  );
  const [openaiProviders, setOpenaiProviders] = useState<OpenAIProviderConfig[]>(
    () => config?.openaiCompatibility || []
  );

  const [configSwitchingKey, setConfigSwitchingKey] = useState<string | null>(null);

  const disableControls = connectionStatus !== 'connected';
  const isSwitching = Boolean(configSwitchingKey);

  const { usageDetails, loadKeyStats } = useProviderStats();

  const getErrorMessage = (err: unknown) => {
    if (err instanceof Error) return err.message;
    if (typeof err === 'string') return err;
    return '';
  };

  const loadConfigs = useCallback(async () => {
    const hasValidCache = isCacheValid();
    if (!hasValidCache) {
      setLoading(true);
    }
    setError('');
    try {
      const [configResult, vertexResult, ampcodeResult] = await Promise.allSettled([
        fetchConfig(undefined, true),
        providersApi.getVertexConfigs(),
        ampcodeApi.getAmpcode(),
      ]);

      if (configResult.status !== 'fulfilled') {
        throw configResult.reason;
      }

      const data = configResult.value;
      console.debug('[AiProviders:loadConfigs] loaded config:', {
        geminiCount: (data?.geminiApiKeys || []).length,
        geminiExcluded: (data?.geminiApiKeys || []).map((c: any, i: number) => ({ i, excluded: c?.excludedModels })),
        openaiCount: (data?.openaiCompatibility || []).length,
        openaiExcluded: (data?.openaiCompatibility || []).map((c: any, i: number) => ({ i, name: c?.name, excluded: c?.excludedModels })),
      });
      setGeminiKeys(data?.geminiApiKeys || []);
      setCodexConfigs(data?.codexApiKeys || []);
      setClaudeConfigs(data?.claudeApiKeys || []);
      setVertexConfigs(data?.vertexApiKeys || []);
      setOpenaiProviders(data?.openaiCompatibility || []);

      if (vertexResult.status === 'fulfilled') {
        setVertexConfigs(vertexResult.value || []);
        updateConfigValue('vertex-api-key', vertexResult.value || []);
        clearCache('vertex-api-key');
      }

      if (ampcodeResult.status === 'fulfilled') {
        updateConfigValue('ampcode', ampcodeResult.value);
        clearCache('ampcode');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err) || t('notification.refresh_failed');
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [clearCache, fetchConfig, isCacheValid, t, updateConfigValue]);

  useEffect(() => {
    if (hasMounted.current) return;
    hasMounted.current = true;
    loadConfigs();
    loadKeyStats();
  }, [loadConfigs, loadKeyStats]);

  useEffect(() => {
    if (config?.geminiApiKeys) setGeminiKeys(config.geminiApiKeys);
    if (config?.codexApiKeys) setCodexConfigs(config.codexApiKeys);
    if (config?.claudeApiKeys) setClaudeConfigs(config.claudeApiKeys);
    if (config?.vertexApiKeys) setVertexConfigs(config.vertexApiKeys);
    if (config?.openaiCompatibility) setOpenaiProviders(config.openaiCompatibility);
  }, [
    config?.geminiApiKeys,
    config?.codexApiKeys,
    config?.claudeApiKeys,
    config?.vertexApiKeys,
    config?.openaiCompatibility,
  ]);

  const openEditor = useCallback(
    (path: string) => {
      navigate(path, { state: { fromAiProviders: true } });
    },
    [navigate]
  );

  const cleanupAuthEntry = (authName: string) => {
    console.debug('[AiProviders:cleanupAuthEntry] authName=', authName, 'calling setStatus(disabled=true)');
    authFilesApi.setStatus(authName, true).then(() => {
      console.debug('[AiProviders:cleanupAuthEntry] setStatus(disabled=true) success for', authName);
    }).catch((err) => {
      console.warn('[AiProviders:cleanupAuthEntry] setStatus failed for', authName, err);
    });
  };

  const deleteGemini = async (index: number) => {
    const entry = geminiKeys[index];
    if (!entry) {
      console.warn('[AiProviders:deleteGemini] no entry at index', index);
      return;
    }
    console.debug('[AiProviders:deleteGemini] index=', index, 'prefix=', entry.prefix, 'apiKey=', entry.apiKey?.slice(0, 8) + '...');
    showConfirmation({
      title: t('ai_providers.gemini_delete_title', { defaultValue: 'Delete Gemini Key' }),
      message: t('ai_providers.gemini_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          console.debug('[AiProviders:deleteGemini] onConfirm: calling deleteGeminiKey and cleanupAuthEntry');
          await providersApi.deleteGeminiKey(entry.apiKey);
          const authId = entry.prefix || entry.apiKey;
          console.debug('[AiProviders:deleteGemini] cleanupAuthEntry authId=', authId);
          cleanupAuthEntry(authId);
          const next = geminiKeys.filter((_, idx) => idx !== index);
          setGeminiKeys(next);
          updateConfigValue('gemini-api-key', next);
          clearCache('gemini-api-key');
          showNotification(t('notification.gemini_key_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const setConfigEnabled = async (
    provider: 'gemini' | 'codex' | 'claude' | 'openai' | 'vertex',
    index: number,
    enabled: boolean
  ) => {
    const syncAuthDisabled = (authName: string, disabled: boolean) => {
      console.debug('[AiProviders:syncAuthDisabled] authName=', authName, 'disabled=', disabled);
      authFilesApi.setStatus(authName, disabled).then(() => {
        console.debug('[AiProviders:syncAuthDisabled] setStatus success for', authName, 'disabled=', disabled);
      }).catch((err) => {
        console.warn('[AiProviders:syncAuthDisabled] setStatus failed for', authName, 'disabled=', disabled, err);
      });
    };

    if (provider === 'gemini') {
      const current = geminiKeys[index];
      if (!current) {
        console.warn('[AiProviders:setConfigEnabled] gemini: no config at index', index);
        return;
      }

      console.debug('[AiProviders:setConfigEnabled] gemini index=', index, 'enabled=', enabled, 'prefix=', current.prefix, 'apiKey=', current.apiKey?.slice(0, 8) + '...');
      const switchingKey = `${provider}:${current.apiKey}`;
      setConfigSwitchingKey(switchingKey);

      const previousList = geminiKeys;
      const nextExcluded = enabled
        ? withoutDisableAllModelsRule(current.excludedModels)
        : withDisableAllModelsRule(current.excludedModels);
      const nextItem: GeminiKeyConfig = { ...current, excludedModels: nextExcluded };
      const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

      setGeminiKeys(nextList);
      updateConfigValue('gemini-api-key', nextList);
      clearCache('gemini-api-key');

      try {
        console.debug('[AiProviders:setConfigEnabled] gemini: saving nextList excludedModels=', nextList.map((c, i) => ({ i, excluded: c.excludedModels })));
        await providersApi.saveGeminiKeys(nextList);
        const authId = current.prefix || current.apiKey;
        console.debug('[AiProviders:setConfigEnabled] gemini: syncAuthDisabled authId=', authId, 'disabled=', !enabled);
        syncAuthDisabled(authId, !enabled);
        showNotification(
          enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
          'success'
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        setGeminiKeys(previousList);
        updateConfigValue('gemini-api-key', previousList);
        clearCache('gemini-api-key');
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    if (provider === 'openai') {
      const current = openaiProviders[index];
      if (!current) {
        console.warn('[AiProviders:setConfigEnabled] openai: no config at index', index);
        return;
      }

      console.debug('[AiProviders:setConfigEnabled] openai index=', index, 'enabled=', enabled, 'name=', current.name, 'prefix=', current.prefix);
      const switchingKey = `openai:${current.name}`;
      setConfigSwitchingKey(switchingKey);

      const previousList = openaiProviders;
      const nextExcluded = enabled
        ? withoutDisableAllModelsRule(current.excludedModels)
        : withDisableAllModelsRule(current.excludedModels);
      const nextItem: OpenAIProviderConfig = { ...current, excludedModels: nextExcluded };
      const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

      setOpenaiProviders(nextList);
      updateConfigValue('openai-compatibility', nextList);
      clearCache('openai-compatibility');

      try {
        console.debug('[AiProviders:setConfigEnabled] openai: saving nextList excludedModels=', nextList.map((c, i) => ({ i, name: c.name, excluded: c.excludedModels })));
        await providersApi.saveOpenAIProviders(nextList);
        const authId = current.prefix || current.name;
        console.debug('[AiProviders:setConfigEnabled] openai: syncAuthDisabled authId=', authId, 'disabled=', !enabled);
        syncAuthDisabled(authId, !enabled);
        showNotification(
          enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
          'success'
        );
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        setOpenaiProviders(previousList);
        updateConfigValue('openai-compatibility', previousList);
        clearCache('openai-compatibility');
        showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
      } finally {
        setConfigSwitchingKey(null);
      }
      return;
    }

    const source = provider === 'codex' ? codexConfigs : provider === 'vertex' ? vertexConfigs : claudeConfigs;
    const current = source[index];
    if (!current) return;

    const switchingKey = `${provider}:${current.apiKey}`;
    setConfigSwitchingKey(switchingKey);

    const previousList = source;
    const nextExcluded = enabled
      ? withoutDisableAllModelsRule(current.excludedModels)
      : withDisableAllModelsRule(current.excludedModels);
    const nextItem: ProviderKeyConfig = { ...current, excludedModels: nextExcluded };
    const nextList = previousList.map((item, idx) => (idx === index ? nextItem : item));

    const setters: Record<string, () => void> = {
      codex: () => { setCodexConfigs(nextList); updateConfigValue('codex-api-key', nextList); clearCache('codex-api-key'); },
      claude: () => { setClaudeConfigs(nextList); updateConfigValue('claude-api-key', nextList); clearCache('claude-api-key'); },
      vertex: () => { setVertexConfigs(nextList); updateConfigValue('vertex-api-key', nextList); clearCache('vertex-api-key'); },
    };
    const rollers: Record<string, () => void> = {
      codex: () => { setCodexConfigs(previousList); updateConfigValue('codex-api-key', previousList); clearCache('codex-api-key'); },
      claude: () => { setClaudeConfigs(previousList); updateConfigValue('claude-api-key', previousList); clearCache('claude-api-key'); },
      vertex: () => { setVertexConfigs(previousList); updateConfigValue('vertex-api-key', previousList); clearCache('vertex-api-key'); },
    };
    const savers: Record<string, () => Promise<unknown>> = {
      codex: () => providersApi.saveCodexConfigs(nextList),
      claude: () => providersApi.saveClaudeConfigs(nextList),
      vertex: () => providersApi.saveVertexConfigs(nextList),
    };

    setters[provider]();

    try {
      await savers[provider]();
      syncAuthDisabled(current.prefix || current.apiKey, !enabled);
      showNotification(
        enabled ? t('notification.config_enabled') : t('notification.config_disabled'),
        'success'
      );
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      rollers[provider]();
      showNotification(`${t('notification.update_failed')}: ${message}`, 'error');
    } finally {
      setConfigSwitchingKey(null);
    }
  };

  const deleteProviderEntry = async (type: 'codex' | 'claude', index: number) => {
    const source = type === 'codex' ? codexConfigs : claudeConfigs;
    const entry = source[index];
    if (!entry) return;
    showConfirmation({
      title: t(`ai_providers.${type}_delete_title`, { defaultValue: `Delete ${type === 'codex' ? 'Codex' : 'Claude'} Config` }),
      message: t(`ai_providers.${type}_delete_confirm`),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          if (type === 'codex') {
            await providersApi.deleteCodexConfig(entry.apiKey);
            cleanupAuthEntry(entry.prefix || entry.apiKey);
            const next = codexConfigs.filter((_, idx) => idx !== index);
            setCodexConfigs(next);
            updateConfigValue('codex-api-key', next);
            clearCache('codex-api-key');
            showNotification(t('notification.codex_config_deleted'), 'success');
          } else {
            await providersApi.deleteClaudeConfig(entry.apiKey);
            cleanupAuthEntry(entry.prefix || entry.apiKey);
            const next = claudeConfigs.filter((_, idx) => idx !== index);
            setClaudeConfigs(next);
            updateConfigValue('claude-api-key', next);
            clearCache('claude-api-key');
            showNotification(t('notification.claude_config_deleted'), 'success');
          }
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteVertex = async (index: number) => {
    const entry = vertexConfigs[index];
    if (!entry) return;
    showConfirmation({
      title: t('ai_providers.vertex_delete_title', { defaultValue: 'Delete Vertex Config' }),
      message: t('ai_providers.vertex_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          await providersApi.deleteVertexConfig(entry.apiKey);
          cleanupAuthEntry(entry.prefix || entry.apiKey);
          const next = vertexConfigs.filter((_, idx) => idx !== index);
          setVertexConfigs(next);
          updateConfigValue('vertex-api-key', next);
          clearCache('vertex-api-key');
          showNotification(t('notification.vertex_config_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  const deleteOpenai = async (index: number) => {
    const entry = openaiProviders[index];
    if (!entry) {
      console.warn('[AiProviders:deleteOpenai] no entry at index', index);
      return;
    }
    console.debug('[AiProviders:deleteOpenai] index=', index, 'name=', entry.name, 'prefix=', entry.prefix);
    showConfirmation({
      title: t('ai_providers.openai_delete_title', { defaultValue: 'Delete OpenAI Provider' }),
      message: t('ai_providers.openai_delete_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        try {
          console.debug('[AiProviders:deleteOpenai] onConfirm: calling deleteOpenAIProvider and cleanupAuthEntry');
          await providersApi.deleteOpenAIProvider(entry.name);
          const authId = entry.prefix || entry.name;
          console.debug('[AiProviders:deleteOpenai] cleanupAuthEntry authId=', authId);
          cleanupAuthEntry(authId);
          const next = openaiProviders.filter((_, idx) => idx !== index);
          setOpenaiProviders(next);
          updateConfigValue('openai-compatibility', next);
          clearCache('openai-compatibility');
          showNotification(t('notification.openai_provider_deleted'), 'success');
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(`${t('notification.delete_failed')}: ${message}`, 'error');
        }
      },
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('ai_providers.title')}</h1>
      </div>
      <div className={styles.content}>
        {error && <div className="error-box">{error}</div>}

        <div id="provider-gemini">
          <GeminiSection
            configs={geminiKeys}
            usageDetails={usageDetails}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            onAdd={() => openEditor('/ai-providers/gemini/new')}
            onEdit={(index) => openEditor(`/ai-providers/gemini/${index}`)}
            onDelete={deleteGemini}
            onToggle={(index, enabled) => void setConfigEnabled('gemini', index, enabled)}
          />
        </div>

        <div id="provider-codex">
          <CodexSection
            configs={codexConfigs}
            usageDetails={usageDetails}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            resolvedTheme={resolvedTheme}
            onAdd={() => openEditor('/ai-providers/codex/new')}
            onEdit={(index) => openEditor(`/ai-providers/codex/${index}`)}
            onDelete={(index) => void deleteProviderEntry('codex', index)}
            onToggle={(index, enabled) => void setConfigEnabled('codex', index, enabled)}
          />
        </div>

        <div id="provider-claude">
          <ClaudeSection
            configs={claudeConfigs}
            usageDetails={usageDetails}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            onAdd={() => openEditor('/ai-providers/claude/new')}
            onEdit={(index) => openEditor(`/ai-providers/claude/${index}`)}
            onDelete={(index) => void deleteProviderEntry('claude', index)}
            onToggle={(index, enabled) => void setConfigEnabled('claude', index, enabled)}
          />
        </div>

        <div id="provider-vertex">
          <VertexSection
            configs={vertexConfigs}
            usageDetails={usageDetails}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            onAdd={() => openEditor('/ai-providers/vertex/new')}
            onEdit={(index) => openEditor(`/ai-providers/vertex/${index}`)}
            onDelete={deleteVertex}
            onToggle={(index, enabled) => void setConfigEnabled('vertex', index, enabled)}
          />
        </div>

        <div id="provider-ampcode">
          <AmpcodeSection
            config={config?.ampcode}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            onEdit={() => openEditor('/ai-providers/ampcode')}
          />
        </div>

        <div id="provider-openai">
          <OpenAISection
            configs={openaiProviders}
            usageDetails={usageDetails}
            loading={loading}
            disableControls={disableControls}
            isSwitching={isSwitching}
            resolvedTheme={resolvedTheme}
            onAdd={() => openEditor('/ai-providers/openai/new')}
            onEdit={(index) => openEditor(`/ai-providers/openai/${index}`)}
            onDelete={deleteOpenai}
            onToggle={(index, enabled) => void setConfigEnabled('openai', index, enabled)}
          />
        </div>
      </div>

      <ProviderNav />
    </div>
  );
}
