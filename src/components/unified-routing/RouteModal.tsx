/**
 * Route Create/Edit Modal
 */

import { useState, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { Route } from '@/types';
import styles from './RouteModal.module.scss';

interface RouteModalProps {
  open: boolean;
  route: Route | null;
  saving: boolean;
  onClose: () => void;
  onSave: (data: { name: string; aliases?: string[]; description?: string; enabled: boolean }) => void;
}

export function RouteModal({ open, route, saving, onClose, onSave }: RouteModalProps) {
  const { t } = useTranslation();
  const isEdit = !!route;

  const [name, setName] = useState('');
  const [aliases, setAliases] = useState<string[]>([]);
  const [aliasInput, setAliasInput] = useState('');
  const [description, setDescription] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<{ name?: string; aliases?: string }>({});
  const aliasInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      if (route) {
        setName(route.name);
        setAliases(route.aliases || []);
        setDescription(route.description || '');
        setEnabled(route.enabled);
      } else {
        setName('');
        setAliases([]);
        setDescription('');
        setEnabled(true);
      }
      setAliasInput('');
      setErrors({});
    }
  }, [open, route]);

  const addAlias = useCallback(() => {
    const value = aliasInput.trim();
    if (!value) return;

    // Support comma-separated input
    const parts = value.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    const newAliases = [...aliases];
    let hasError = false;

    for (const part of parts) {
      if (!/^[a-zA-Z0-9._-]+$/.test(part)) {
        hasError = true;
        setErrors((prev) => ({ ...prev, aliases: t('unified_routing.alias_invalid', { name: part }) }));
        break;
      }
      // Avoid duplicates (case-insensitive) and don't allow alias = name
      const lc = part.toLowerCase();
      if (lc === name.trim().toLowerCase()) continue;
      if (newAliases.some((a) => a.toLowerCase() === lc)) continue;
      newAliases.push(part);
    }

    if (!hasError) {
      setAliases(newAliases);
      setAliasInput('');
      setErrors((prev) => ({ ...prev, aliases: undefined }));
    }
  }, [aliasInput, aliases, name, t]);

  const removeAlias = useCallback((index: number) => {
    setAliases((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleAliasKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addAlias();
    } else if (e.key === 'Backspace' && !aliasInput && aliases.length > 0) {
      // Remove last alias on backspace when input is empty
      setAliases((prev) => prev.slice(0, -1));
    }
  }, [addAlias, aliasInput, aliases.length]);

  const validate = () => {
    const newErrors: { name?: string; aliases?: string } = {};
    
    if (!name.trim()) {
      newErrors.name = t('unified_routing.route_name_required');
    } else if (!/^[a-zA-Z0-9._-]+$/.test(name.trim())) {
      newErrors.name = t('unified_routing.route_name_invalid');
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    // Flush any pending alias input
    if (aliasInput.trim()) {
      addAlias();
    }
    if (!validate()) return;
    
    onSave({
      name: name.trim(),
      aliases: aliases.length > 0 ? aliases : undefined,
      description: description.trim() || undefined,
      enabled,
    });
  };

  return (
    <Modal
      open={open}
      title={isEdit ? t('unified_routing.edit_route') : t('unified_routing.create_route')}
      onClose={onClose}
      closeDisabled={saving}
      footer={
        <div className="modal-footer-buttons">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={saving}>
            {isEdit ? t('common.save') : t('common.create')}
          </Button>
        </div>
      }
    >
      <div className="form-group">
        <label className="form-label">
          {t('unified_routing.route_name')}
          <span className="required">*</span>
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('unified_routing.route_name_placeholder')}
          disabled={saving}
          error={errors.name}
        />
        <div className="form-hint">{t('unified_routing.route_name_hint')}</div>
      </div>

      <div className="form-group">
        <label className="form-label">{t('unified_routing.route_aliases')}</label>
        <div className={styles.aliasContainer}>
          {aliases.map((alias, idx) => (
            <span key={alias} className={styles.aliasTag}>
              {alias}
              <button
                type="button"
                className={styles.aliasRemove}
                onClick={() => removeAlias(idx)}
                disabled={saving}
                aria-label={`Remove ${alias}`}
              >
                &times;
              </button>
            </span>
          ))}
          <input
            ref={aliasInputRef}
            className={styles.aliasInput}
            value={aliasInput}
            onChange={(e) => setAliasInput(e.target.value)}
            onKeyDown={handleAliasKeyDown}
            onBlur={addAlias}
            placeholder={aliases.length === 0 ? t('unified_routing.route_aliases_placeholder') : ''}
            disabled={saving}
          />
        </div>
        {errors.aliases && <div className="form-error">{errors.aliases}</div>}
        <div className="form-hint">{t('unified_routing.route_aliases_hint')}</div>
      </div>

      <div className="form-group">
        <label className="form-label">{t('unified_routing.route_description')}</label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('unified_routing.route_description_placeholder')}
          disabled={saving}
        />
      </div>

      <div className="form-group form-group-inline">
        <label className="form-label">{t('unified_routing.route_enabled')}</label>
        <ToggleSwitch
          checked={enabled}
          onChange={setEnabled}
          disabled={saving}
        />
      </div>
    </Modal>
  );
}
