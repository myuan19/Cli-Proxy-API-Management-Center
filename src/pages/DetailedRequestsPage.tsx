/**
 * DetailedRequestsPage - 独立的请求详情页面
 *
 * 无侧边栏和顶部导航的全页显示模式，
 * 复刻原后端 detailed_requests.html 的布局：
 * 返回链接 + 标题 + 副标题 + 完整内容区。
 */

import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DetailedRequestsTab } from '@/components/logs/DetailedRequestsTab';
import styles from './DetailedRequestsPage.module.scss';

export function DetailedRequestsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className={styles.page}>
      <a
        className={styles.backLink}
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
        href="#/"
      >
        &larr; {t('detailed_requests.back_to_management')}
      </a>
      <h1 className={styles.title}>{t('detailed_requests.page_title')}</h1>
      <p className={styles.subtitle}>{t('detailed_requests.page_subtitle')}</p>
      <DetailedRequestsTab />
    </div>
  );
}
