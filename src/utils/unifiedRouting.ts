import type { CredentialInfo } from '@/types';

/**
 * 获取凭证的显示标签。
 * 当 label 为通用名（如 provider 或 provider-apikey）时，用 masked api_key 作为凭证标识，
 * 便于区分同一 provider 下的多个 API key 凭证（如 siliconflow、gemini）。
 */
export function getCredentialDisplayLabel(cred: CredentialInfo): string {
  const label = cred.label?.trim() || '';
  const provider = cred.provider?.toLowerCase() || '';
  const isGenericLabel =
    !label ||
    label.toLowerCase() === provider ||
    label.toLowerCase() === `${provider}-apikey` ||
    label === 'openai-compatibility';
  if (cred.type === 'api-key' && cred.api_key && isGenericLabel) {
    return cred.api_key;
  }
  return label || cred.api_key || cred.id;
}

/** 带渠道名的凭证标签，用于混合展示多个 provider 时（如选择凭证下拉框） */
export function getCredentialDisplayLabelWithProvider(cred: CredentialInfo): string {
  const label = getCredentialDisplayLabel(cred);
  return `${cred.provider || 'unknown'} / ${label}`;
}
