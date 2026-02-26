/**
 * Target Create/Edit Modal
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Select, type SelectOption } from '@/components/ui/Select';
import selectStyles from '@/components/ui/Select.module.scss';
import { getCredentialDisplayLabelWithProvider } from '@/utils/unifiedRouting';
import type { Target, CredentialInfo } from '@/types';

interface TargetModalProps {
  open: boolean;
  target: Target | null;
  layerLevel: number;
  credentials: CredentialInfo[];
  saving: boolean;
  onClose: () => void;
  onSave: (layerLevel: number, target: Target, isEdit: boolean) => void;
}

export function TargetModal({
  open,
  target,
  layerLevel,
  credentials,
  saving,
  onClose,
  onSave,
}: TargetModalProps) {
  const { t } = useTranslation();
  const isEdit = !!target;

  const [credentialId, setCredentialId] = useState('');
  const [model, setModel] = useState('');
  const [weight, setWeight] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [errors, setErrors] = useState<{ credentialId?: string; model?: string }>({});

  // Models for selected credential
  const selectedCredential = credentials.find((c) => c.id === credentialId);
  const availableModels = selectedCredential?.models || [];

  useEffect(() => {
    if (open) {
      if (target) {
        setCredentialId(target.credential_id);
        setModel(target.model);
        setWeight(target.weight || 1);
        setEnabled(target.enabled);
      } else {
        setCredentialId('');
        setModel('');
        setWeight(1);
        setEnabled(true);
      }
      setErrors({});
    }
  }, [open, target]);

  const validate = () => {
    const newErrors: { credentialId?: string; model?: string } = {};
    
    if (!credentialId) {
      newErrors.credentialId = t('unified_routing.credential_required');
    }
    if (!model.trim()) {
      newErrors.model = t('unified_routing.model_required');
    }
    
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;
    
    const newTarget: Target = {
      id: target?.id || `target-${Date.now()}`,
      credential_id: credentialId,
      model: model.trim(),
      weight: weight > 1 ? weight : undefined,
      enabled,
    };
    
    onSave(layerLevel, newTarget, isEdit);
  };

  const credentialOptions: SelectOption[] = credentials.map((cred) => ({
    value: cred.id,
    label: getCredentialDisplayLabelWithProvider(cred),
    optionClassName: cred.status === 'disabled' ? selectStyles.optionDisabled : undefined,
  }));

  return (
    <Modal
      open={open}
      title={isEdit ? t('unified_routing.edit_target') : t('unified_routing.add_target')}
      onClose={onClose}
      closeDisabled={saving}
      footer={
        <div className="modal-footer-buttons">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={handleSubmit} loading={saving}>
            {isEdit ? t('common.save') : t('common.add')}
          </Button>
        </div>
      }
    >
      <div className="form-group">
        <label className="form-label">
          {t('unified_routing.credential')}
          <span className="required">*</span>
        </label>
        <Select
          value={credentialId}
          options={credentialOptions}
          onChange={(v) => {
            setCredentialId(v);
            setModel('');
          }}
          placeholder={t('unified_routing.select_credential')}
          disabled={saving}
          className={errors.credentialId ? 'error' : ''}
        />
        {errors.credentialId && <div className="form-error">{errors.credentialId}</div>}
      </div>

      <div className="form-group">
        <label className="form-label">
          {t('unified_routing.model')}
          <span className="required">*</span>
        </label>
        {availableModels.length > 0 ? (
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={saving || !credentialId}
            className={errors.model ? 'error' : ''}
          >
            <option value="">{t('unified_routing.select_model')}</option>
            {availableModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
              </option>
            ))}
          </select>
        ) : (
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={t('unified_routing.model_placeholder')}
            disabled={saving || !credentialId}
            error={errors.model}
          />
        )}
      </div>

      <div className="form-group">
        <label className="form-label">{t('unified_routing.weight')}</label>
        <Input
          type="number"
          value={weight}
          onChange={(e) => setWeight(parseInt(e.target.value) || 1)}
          min={1}
          max={100}
          disabled={saving}
        />
        <div className="form-hint">{t('unified_routing.weight_hint')}</div>
      </div>

      <div className="form-group form-group-inline">
        <label className="form-label">{t('unified_routing.target_enabled')}</label>
        <ToggleSwitch
          checked={enabled}
          onChange={setEnabled}
          disabled={saving}
        />
      </div>
    </Modal>
  );
}
