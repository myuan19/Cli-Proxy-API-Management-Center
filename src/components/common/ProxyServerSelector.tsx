/**
 * 代理选择器：从已保存的代理服务器中选择，或手动输入
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { proxyServersApi } from '@/services/api';
import type { ProxyServer } from '@/services/api/proxyServers';

export type ProxyServerSelectorValue = {
  proxyUrl: string;
  proxyDns?: string;
  prefix?: string;
};

export interface ProxyServerSelectorProps {
  value: ProxyServerSelectorValue;
  onChange: (v: ProxyServerSelectorValue) => void;
  disabled?: boolean;
  /** 是否显示 prefix 字段（Provider 表单使用） */
  showPrefix?: boolean;
  /** 仅 proxyUrl（配置面板使用，无 proxyDns） */
  proxyUrlOnly?: boolean;
  /** 紧凑模式（表格内嵌等场景） */
  compact?: boolean;
}

type Mode = 'none' | 'from_list' | 'custom';

const MODE_NONE = 'none';
const MODE_FROM_LIST = 'from_list';
const MODE_CUSTOM = 'custom';

function detectMode(
  value: ProxyServerSelectorValue,
  servers: ProxyServer[]
): { mode: Mode; selectedId: string } {
  const url = (value.proxyUrl ?? '').trim();
  if (!url) return { mode: MODE_NONE, selectedId: '' };
  const match = servers.find((s) => (s.proxy_url ?? '').trim() === url);
  if (match) return { mode: MODE_FROM_LIST, selectedId: match.id };
  return { mode: MODE_CUSTOM, selectedId: '' };
}

export function ProxyServerSelector({
  value,
  onChange,
  disabled = false,
  showPrefix = false,
  proxyUrlOnly = false,
  compact = false,
}: ProxyServerSelectorProps) {
  const { t } = useTranslation();
  const [servers, setServers] = useState<ProxyServer[]>([]);
  const [loading, setLoading] = useState(true);
  /** 用户显式选择「手动输入」时保持该模式，避免 detectMode 因空 URL 切回「无」 */
  const [forceCustomMode, setForceCustomMode] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    proxyServersApi
      .list()
      .then((data) => {
        if (!cancelled) setServers(data?.servers ?? []);
      })
      .catch(() => {
        if (!cancelled) setServers([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const detected = detectMode(value, servers);
  const mode = forceCustomMode ? MODE_CUSTOM : detected.mode;
  const selectedId = detected.selectedId;

  useEffect(() => {
    // 仅当 value 明确匹配列表中的代理时清除强制 custom，避免与外部 value 不一致
    if (detected.mode === MODE_FROM_LIST && forceCustomMode) {
      setForceCustomMode(false);
    }
  }, [detected.mode, forceCustomMode]);

  const modeOptions = [
    { value: MODE_NONE, label: t('proxy_selector.mode_none', { defaultValue: '无' }) },
    { value: MODE_FROM_LIST, label: t('proxy_selector.mode_from_list', { defaultValue: '从列表选择' }) },
    { value: MODE_CUSTOM, label: t('proxy_selector.mode_custom', { defaultValue: '手动输入' }) },
  ];

  const handleModeChange = useCallback(
    (nextMode: string) => {
      if (nextMode === MODE_NONE) {
        setForceCustomMode(false);
        onChange({ proxyUrl: '', proxyDns: '', prefix: '' });
      } else if (nextMode === MODE_FROM_LIST && servers.length > 0) {
        setForceCustomMode(false);
        const first = servers[0];
        onChange({
          proxyUrl: first.proxy_url ?? '',
          proxyDns: first.proxy_dns ?? '',
          prefix: first.prefix ?? '',
        });
      } else if (nextMode === MODE_CUSTOM) {
        setForceCustomMode(true);
        if (mode !== MODE_CUSTOM) {
          onChange({
            proxyUrl: value.proxyUrl ?? '',
            proxyDns: value.proxyDns ?? '',
            prefix: value.prefix ?? '',
          });
        }
      }
    },
    [onChange, servers, mode, value]
  );

  const handleServerSelect = useCallback(
    (id: string) => {
      const s = servers.find((x) => x.id === id);
      if (s) {
        onChange({
          proxyUrl: s.proxy_url ?? '',
          proxyDns: s.proxy_dns ?? '',
          prefix: s.prefix ?? '',
        });
      }
    },
    [onChange, servers]
  );

  const serverOptions = servers.map((s) => ({
    value: s.id,
    label: (s.prefix || s.proxy_url || s.id).slice(0, 60),
  }));

  return (
    <div
      className="proxy-server-selector"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: compact ? 6 : 12,
      }}
    >
      <div className="form-group">
        <label>{t('common.proxy_url')}</label>
        <Select
          value={mode}
          options={modeOptions}
          onChange={handleModeChange}
          placeholder={t('proxy_selector.select_mode', { defaultValue: '选择方式' })}
          disabled={disabled || loading}
          ariaLabel={t('common.proxy_url')}
        />
      </div>
      {mode === MODE_FROM_LIST && servers.length > 0 && (
        <div className="form-group">
          <label>{t('proxy_selector.select_proxy', { defaultValue: '选择代理' })}</label>
          <Select
            value={selectedId}
            options={serverOptions}
            onChange={handleServerSelect}
            placeholder={t('proxy_selector.select_placeholder', { defaultValue: '请选择...' })}
            disabled={disabled}
            ariaLabel={t('proxy_selector.select_proxy', { defaultValue: '选择代理' })}
          />
        </div>
      )}
      {mode === MODE_CUSTOM && (
        <>
          <Input
            label={t('basic_settings.proxy_url_label', { defaultValue: '代理 URL' })}
            value={value.proxyUrl ?? ''}
            onChange={(e) => onChange({ ...value, proxyUrl: e.target.value })}
            placeholder={t('basic_settings.proxy_url_placeholder')}
            hint={!proxyUrlOnly ? undefined : t('basic_settings.proxy_url_hint')}
            disabled={disabled}
          />
          {!proxyUrlOnly && (
            <Input
              label={t('common.proxy_dns_label')}
              value={value.proxyDns ?? ''}
              onChange={(e) => onChange({ ...value, proxyDns: e.target.value })}
              placeholder={t('common.proxy_dns_placeholder')}
              hint={t('common.proxy_dns_hint')}
              disabled={disabled}
            />
          )}
          {showPrefix && (
            <Input
              label={t('common.prefix')}
              value={value.prefix ?? ''}
              onChange={(e) => onChange({ ...value, prefix: e.target.value })}
              placeholder={t('proxy_servers.prefix_placeholder')}
              disabled={disabled}
            />
          )}
        </>
      )}
    </div>
  );
}
