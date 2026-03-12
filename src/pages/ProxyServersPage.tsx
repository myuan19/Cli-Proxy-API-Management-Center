/**
 * 代理服务器管理页
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import {
  IconRefreshCw,
  IconTrash2,
  IconCheck,
  IconSend,
} from '@/components/ui/icons';
import { useAuthStore, useNotificationStore } from '@/stores';
import { proxyServersApi, authFilesApi } from '@/services/api';
import type { ProxyServer } from '@/services/api/proxyServers';
import type { AuthFileItem } from '@/types';
import styles from './ProxyServersPage.module.scss';

export function ProxyServersPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const { showNotification, showConfirmation } = useNotificationStore();

  const [servers, setServers] = useState<ProxyServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [authFiles, setAuthFiles] = useState<AuthFileItem[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formPrefix, setFormPrefix] = useState('');
  const [formProxyUrl, setFormProxyUrl] = useState('');
  const [formProxyDns, setFormProxyDns] = useState('');
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [checkAllLoading, setCheckAllLoading] = useState(false);
  const [healthResults, setHealthResults] = useState<Record<string, { status: 'healthy' | 'unhealthy'; message?: string; latency_ms?: number }>>({});
  const [healthDetailModal, setHealthDetailModal] = useState<{
    server: ProxyServer;
    result: { status: string; message?: string; latency_ms?: number };
  } | null>(null);
  const [applyModalOpen, setApplyModalOpen] = useState(false);
  const [applyTargetId, setApplyTargetId] = useState<string | null>(null);
  const [applyAuthName, setApplyAuthName] = useState('');
  const [applying, setApplying] = useState(false);

  const disableControls = connectionStatus !== 'connected';

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await proxyServersApi.list();
      setServers(data?.servers ?? []);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadAuthFiles = useCallback(async () => {
    try {
      const data = await authFilesApi.list();
      setAuthFiles(data?.files ?? []);
    } catch {
      setAuthFiles([]);
    }
  }, []);

  useHeaderRefresh(loadServers);

  useEffect(() => {
    loadServers();
    loadAuthFiles();
  }, [loadServers, loadAuthFiles]);

  const openCreateModal = () => {
    setEditingId(null);
    setFormPrefix('');
    setFormProxyUrl('');
    setFormProxyDns('');
    setFormError('');
    setModalOpen(true);
  };

  const openEditModal = (s: ProxyServer) => {
    setEditingId(s.id);
    setFormPrefix(s.prefix ?? '');
    setFormProxyUrl(s.proxy_url ?? '');
    setFormProxyDns(s.proxy_dns ?? '');
    setFormError('');
    setModalOpen(true);
  };

  const handleSave = async () => {
    const url = formProxyUrl.trim();
    if (!url) {
      setFormError(t('proxy_servers.error_proxy_url_required'));
      return;
    }
    setSaving(true);
    setFormError('');
    try {
      if (editingId) {
        await proxyServersApi.update(editingId, {
          prefix: formPrefix.trim(),
          proxy_url: url,
          proxy_dns: formProxyDns.trim() || undefined,
        });
        showNotification(t('proxy_servers.updated'), 'success');
      } else {
        await proxyServersApi.create({
          prefix: formPrefix.trim(),
          proxy_url: url,
          proxy_dns: formProxyDns.trim() || undefined,
        });
        showNotification(t('proxy_servers.created'), 'success');
      }
      setModalOpen(false);
      loadServers();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('notification.save_failed');
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (s: ProxyServer) => {
    showConfirmation({
      title: t('proxy_servers.delete_confirm_title'),
      message: t('proxy_servers.delete_confirm_message', { prefix: s.prefix || s.proxy_url }),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        await proxyServersApi.delete(s.id);
        showNotification(t('proxy_servers.deleted'), 'success');
        loadServers();
      },
    });
  };

  const handleCheck = async (id: string) => {
    setCheckingId(id);
    try {
      const res = await proxyServersApi.check(id);
      setHealthResults((prev) => ({
        ...prev,
        [id]: {
          status: res.status,
          message: res.message,
          latency_ms: res.latency_ms,
        },
      }));
      if (res.status === 'healthy') {
        showNotification(
          t('proxy_servers.check_healthy', { ms: res.latency_ms ?? '-' }),
          'success'
        );
      } else {
        showNotification(res.message ?? t('proxy_servers.check_unhealthy'), 'error');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('proxy_servers.check_failed');
      setHealthResults((prev) => ({
        ...prev,
        [id]: { status: 'unhealthy', message: msg },
      }));
      showNotification(msg, 'error');
    } finally {
      setCheckingId(null);
    }
  };

  const handleCheckAll = async () => {
    if (checkAllLoading || disableControls || servers.length === 0) return;
    setCheckAllLoading(true);
    try {
      await proxyServersApi.checkAllStream(
        (result) => {
          setHealthResults((prev) => ({
            ...prev,
            [result.id]: {
              status: result.status,
              message: result.message,
              latency_ms: result.latency_ms,
            },
          }));
        },
        () => {
          setCheckAllLoading(false);
          showNotification(t('proxy_servers.check_all_done', { defaultValue: '全部检查完成' }), 'success');
        }
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('proxy_servers.check_failed');
      showNotification(msg, 'error');
      setCheckAllLoading(false);
    }
  };

  const openApplyModal = (id: string) => {
    setApplyTargetId(id);
    setApplyAuthName('');
    setApplyModalOpen(true);
  };

  const handleApply = async () => {
    const id = applyTargetId;
    const name = applyAuthName.trim();
    if (!id || !name) {
      showNotification(t('proxy_servers.apply_name_required'), 'error');
      return;
    }
    setApplying(true);
    try {
      await proxyServersApi.applyToAuthFile(id, name);
      showNotification(t('proxy_servers.apply_success'), 'success');
      setApplyModalOpen(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t('notification.save_failed');
      showNotification(msg, 'error');
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('proxy_servers.title')}</h1>
        <p className={styles.description}>{t('proxy_servers.description')}</p>
        <div className={styles.headerActions}>
          <Button
            variant="primary"
            size="sm"
            onClick={openCreateModal}
            disabled={disableControls}
          >
            {t('common.add')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCheckAll}
            loading={checkAllLoading}
            disabled={disableControls || servers.length === 0 || checkAllLoading}
            title={t('proxy_servers.check_all_button', { defaultValue: '全部检查' })}
          >
            {t('proxy_servers.check_all_button', { defaultValue: '全部检查' })}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadServers}
            loading={loading}
            disabled={disableControls}
          >
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      {error && <div className={styles.errorBox}>{error}</div>}

      <Card>
        {loading ? (
          <div style={{ padding: '2rem', textAlign: 'center' }}>
            <LoadingSpinner />
          </div>
        ) : servers.length === 0 ? (
          <EmptyState
            title={t('proxy_servers.empty_title')}
            description={t('proxy_servers.empty_description')}
            action={
              <Button variant="primary" onClick={openCreateModal} disabled={disableControls}>
                {t('common.add')}
              </Button>
            }
          />
        ) : (
          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: 72 }}>{t('common.status')}</th>
                  <th>{t('common.prefix')}</th>
                  <th>{t('common.proxy_url')}</th>
                  <th>{t('common.proxy_dns_label')}</th>
                  <th>{t('common.action')}</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => {
                  const res = healthResults[s.id];
                  return (
                  <tr key={s.id}>
                    <td>
                      {res ? (
                        <span
                          className={`${styles.healthIndicator} ${
                            res.status === 'healthy' ? styles.healthIndicatorHealthy : styles.healthIndicatorUnhealthy
                          }`}
                          onClick={() =>
                            setHealthDetailModal({
                              server: s,
                              result: res,
                            })
                          }
                          title={t('proxy_servers.health_detail_click', { defaultValue: '点击查看请求/响应详情' })}
                        >
                          {res.status === 'healthy'
                            ? `${res.latency_ms ?? '-'}ms`
                            : '✗'}
                        </span>
                      ) : (
                        <span className={styles.healthIndicatorPlaceholder}>-</span>
                      )}
                    </td>
                    <td className={styles.cellPrefix}>{s.prefix || '-'}</td>
                    <td className={styles.cellUrl} title={s.proxy_url}>
                      {s.proxy_url}
                    </td>
                    <td className={styles.cellDns}>{s.proxy_dns || '-'}</td>
                    <td>
                      <div className={styles.actions}>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCheck(s.id)}
                          loading={checkingId === s.id}
                          disabled={disableControls}
                          title={t('proxy_servers.check_connectivity')}
                        >
                          <IconCheck size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openApplyModal(s.id)}
                          disabled={disableControls}
                          title={t('proxy_servers.apply_to_credential')}
                        >
                          <IconSend size={14} />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditModal(s)}
                          disabled={disableControls}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(s)}
                          disabled={disableControls}
                          title={t('common.delete')}
                        >
                          <IconTrash2 size={14} />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingId ? t('proxy_servers.edit_title') : t('proxy_servers.create_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSave} loading={saving}>
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <Input
            label={t('common.prefix')}
            value={formPrefix}
            onChange={(e) => setFormPrefix(e.target.value)}
            placeholder={t('proxy_servers.prefix_placeholder')}
          />
          <Input
            label={t('common.proxy_url')}
            value={formProxyUrl}
            onChange={(e) => setFormProxyUrl(e.target.value)}
            placeholder={t('basic_settings.proxy_url_placeholder')}
            hint={t('basic_settings.proxy_url_hint')}
            error={formError}
          />
          <Input
            label={t('common.proxy_dns_label')}
            value={formProxyDns}
            onChange={(e) => setFormProxyDns(e.target.value)}
            placeholder={t('common.proxy_dns_placeholder')}
            hint={t('common.proxy_dns_hint')}
          />
        </div>
      </Modal>

      <Modal
        open={applyModalOpen}
        onClose={() => setApplyModalOpen(false)}
        title={t('proxy_servers.apply_title')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setApplyModalOpen(false)} disabled={applying}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleApply} loading={applying} disabled={!applyAuthName.trim()}>
              {t('proxy_servers.apply_button')}
            </Button>
          </>
        }
      >
        <div className={styles.modalForm}>
          <label className="form-group">
            <span style={{ display: 'block', marginBottom: 4, fontWeight: 500 }}>
              {t('proxy_servers.select_credential')}
            </span>
            <select
              className="input"
              value={applyAuthName}
              onChange={(e) => setApplyAuthName(e.target.value)}
              style={{ width: '100%', padding: '8px 12px' }}
            >
              <option value="">{t('proxy_servers.select_placeholder')}</option>
              {authFiles.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Modal>

      {/* 健康检查详情：请求/响应/报错 */}
      <Modal
        open={Boolean(healthDetailModal)}
        onClose={() => setHealthDetailModal(null)}
        title={
          healthDetailModal
            ? `${t('proxy_servers.health_detail_title', { defaultValue: '连通性检查详情' })} - ${healthDetailModal.server.prefix || healthDetailModal.server.proxy_url}`
            : ''
        }
        width={560}
        footer={
          <Button variant="secondary" onClick={() => setHealthDetailModal(null)}>
            {t('common.close')}
          </Button>
        }
      >
        {healthDetailModal && (
          <div className={styles.healthDetailContent}>
            <div className={styles.healthDetailSection}>
              <div className={styles.healthDetailLabel}>
                {t('proxy_servers.health_detail_request', { defaultValue: '测试请求' })}
              </div>
              <pre className={styles.healthDetailPre}>
{`GET https://www.google.com/generate_204
Via: ${healthDetailModal.server.proxy_url}${healthDetailModal.server.proxy_dns ? `\nDNS: ${healthDetailModal.server.proxy_dns}` : ''}`}
              </pre>
            </div>
            <div className={styles.healthDetailSection}>
              <div className={styles.healthDetailLabel}>
                {t('proxy_servers.health_detail_response', { defaultValue: '响应/报错' })}
              </div>
              <pre className={styles.healthDetailPre}>
                {healthDetailModal.result.status === 'healthy'
                  ? `200 OK\n${t('proxy_servers.health_detail_success', { defaultValue: '成功' })} (${healthDetailModal.result.latency_ms ?? '-'}ms)`
                  : healthDetailModal.result.message || t('common.unknown_error')}
              </pre>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
