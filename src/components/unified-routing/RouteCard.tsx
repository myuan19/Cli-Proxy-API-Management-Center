/**
 * Route Card Component
 * Displays a route with its layer/target structure
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { unifiedRoutingApi } from '@/services/api/unifiedRouting';
import type { Route, Pipeline, RouteState, CredentialInfo, Target, HealthResult, Layer } from '@/types';
import styles from './RouteCard.module.scss';

interface RouteCardProps {
  route: Route & { pipeline_summary: { total_layers: number; total_targets: number } };
  pipeline: Pipeline | null;
  routeState: RouteState | null;
  credentials: CredentialInfo[];
  loading?: boolean;
  disabled?: boolean;
  onEdit: (routeId: string) => void;
  onDelete: (routeId: string) => void;
  onAddTarget: (routeId: string, layerLevel: number) => void;
  onEditTarget: (routeId: string, layerLevel: number, target: Target) => void;
  onDeleteTarget: (routeId: string, layerLevel: number, targetId: string) => void;
  onDeleteLayer: (routeId: string, layerLevel: number) => void;
  onAddLayer: (routeId: string) => void;
  onSelect: (routeId: string) => void;
  onPipelineChange?: (routeId: string, pipeline: Pipeline) => void;
}

interface TargetHealthStatus {
  status: 'checking' | 'success' | 'failed' | 'skipped';
  message?: string;
  latency_ms?: number;
}

interface ErrorModalInfo {
  targetName: string;
  errorMessage: string;
}

type CredentialStatus = 'ok' | 'disabled' | 'not_found';

interface TargetDragState {
  srcLayerIdx: number;
  srcTargetIdx: number;
  ghostEl: HTMLElement;
  startX: number;
  startY: number;
  pointerId: number;
  rowHeight: number;
}

interface LayerDragState {
  srcLayerIdx: number;
  ghostEl: HTMLElement;
  startY: number;
  pointerId: number;
  layerHeight: number;
}

interface TargetDropPos {
  layerIdx: number;
  targetIdx: number;
}

function reorderTargets(layers: Layer[], src: TargetDropPos, dst: TargetDropPos): Layer[] {
  if (src.layerIdx === dst.layerIdx && src.targetIdx === dst.targetIdx) return layers;
  const result = layers.map(l => ({ ...l, targets: [...l.targets] }));
  const srcLayer = result[src.layerIdx];
  const dstLayer = result[dst.layerIdx];
  if (!srcLayer || !dstLayer) return layers;
  const [item] = srcLayer.targets.splice(src.targetIdx, 1);
  if (!item) return layers;
  let insertIdx = dst.targetIdx;
  if (src.layerIdx === dst.layerIdx && src.targetIdx < dst.targetIdx) insertIdx--;
  insertIdx = Math.max(0, Math.min(insertIdx, dstLayer.targets.length));
  dstLayer.targets.splice(insertIdx, 0, item);
  return result;
}

export function RouteCard({
  route,
  pipeline,
  routeState,
  credentials,
  loading,
  disabled,
  onEdit,
  onDelete,
  onAddTarget,
  onEditTarget,
  onDeleteTarget,
  onDeleteLayer,
  onAddLayer,
  onSelect,
  onPipelineChange,
}: RouteCardProps) {
  const { t } = useTranslation();
  
  const storageKey = `route-expanded-${route.id}`;
  const [expanded, setExpanded] = useState(() => {
    const stored = localStorage.getItem(storageKey);
    return stored !== 'false';
  });
  
  const handleToggleExpand = () => {
    const newState = !expanded;
    setExpanded(newState);
    localStorage.setItem(storageKey, String(newState));
  };
  
  const [simulating, setSimulating] = useState(false);
  const [simulateStatus, setSimulateStatus] = useState<Record<string, TargetHealthStatus>>({});
  const [checkingAll, setCheckingAll] = useState(false);
  const [healthCheckStatus, setHealthCheckStatus] = useState<Record<string, TargetHealthStatus>>({});
  const [errorModal, setErrorModal] = useState<ErrorModalInfo | null>(null);

  // --- Target drag state ---
  const targetDragRef = useRef<TargetDragState | null>(null);
  const [isDraggingTarget, setIsDraggingTarget] = useState(false);
  const [targetDragSrc, setTargetDragSrc] = useState<TargetDropPos | null>(null);
  const [targetDragDst, setTargetDragDst] = useState<TargetDropPos | null>(null);

  // --- Layer drag state ---
  const layerDragRef = useRef<LayerDragState | null>(null);
  const [isDraggingLayer, setIsDraggingLayer] = useState(false);
  const [layerDragSrc, setLayerDragSrc] = useState<number | null>(null);
  const [layerDragDst, setLayerDragDst] = useState<number | null>(null);

  // Refs for measuring positions
  const layersContainerRef = useRef<HTMLDivElement>(null);
  const layerRefsByLevel = useRef<Map<number, HTMLDivElement>>(new Map()); // keyed by layer.level
  const layerRefs = useRef<(HTMLDivElement | null)[]>([]); // display-order (for layer drag hit-test)
  const targetRowRefs = useRef<Map<string, HTMLDivElement>>(new Map()); // keyed by target.id

  const handleCheckAll = async () => {
    if (!pipeline) return;
    
    setCheckingAll(true);
    const allTargets: Record<string, TargetHealthStatus> = {};
    pipeline.layers.forEach(layer => {
      layer.targets.forEach(target => {
        if (target.enabled) {
          allTargets[target.id] = { status: 'checking' };
        }
      });
    });
    setHealthCheckStatus({ ...allTargets });
    
    try {
      await unifiedRoutingApi.triggerHealthCheckStream(route.id, {
        onResult: (result: HealthResult) => {
          setHealthCheckStatus(prev => ({
            ...prev,
            [result.target_id]: {
              status: result.status === 'healthy' ? 'success' : 'failed',
              message: result.message,
              latency_ms: result.latency_ms,
            },
          }));
        },
        onDone: () => {
          setCheckingAll(false);
        },
      });
    } catch (error) {
      console.error('Check all failed:', error);
      setHealthCheckStatus(prev => {
        const updated = { ...prev };
        Object.keys(updated).forEach(id => {
          if (updated[id].status === 'checking') {
            updated[id] = { status: 'failed', message: 'Check failed' };
          }
        });
        return updated;
      });
    } finally {
      setCheckingAll(false);
    }
  };
  
  const handleSimulateRoute = async () => {
    setSimulating(true);
    setSimulateStatus({});
    
    try {
      const result = await unifiedRoutingApi.simulateRoute(route.id, false);
      
      const newStatus: Record<string, TargetHealthStatus> = {};
      result.attempts.forEach(layer => {
        layer.targets.forEach(target => {
          newStatus[target.target_id] = {
            status: target.status === 'success' ? 'success' : 'failed',
            message: target.message,
            latency_ms: target.latency_ms,
          };
        });
      });
      setSimulateStatus(newStatus);
    } catch (error) {
      console.error('Simulate route failed:', error);
    } finally {
      setSimulating(false);
    }
  };
  
  const clearAllResults = () => {
    setSimulateStatus({});
    setHealthCheckStatus({});
  };
  
  const hasAnyResults = Object.keys(simulateStatus).length > 0 || Object.keys(healthCheckStatus).length > 0;

  const getCredentialInfo = (credentialId: string) => {
    return credentials?.find((c) => c.id === credentialId);
  };

  const getCredentialStatus = (credentialId: string): CredentialStatus => {
    const cred = credentials?.find((c) => c.id === credentialId);
    if (!cred) return 'not_found';
    if (cred.status === 'disabled') return 'disabled';
    return 'ok';
  };

  const getTargetState = (targetId: string) => {
    if (!routeState) return null;
    for (const layer of routeState.layers) {
      const target = layer.targets.find((t) => t.target_id === targetId);
      if (target) return target;
    }
    return null;
  };

  const formatCooldown = (state: { status?: string; cooldown_remaining_seconds?: number; cooldown_ends_at?: string | null } | null) => {
    if (!state || state.status !== 'cooling') return null;
    const sec = state.cooldown_remaining_seconds ?? 0;
    if (sec > 0) {
      if (sec < 60) return `${sec}s`;
      return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    }
    if (state.cooldown_ends_at == null || state.cooldown_ends_at === '') return t('unified_routing.cooling');
    return null;
  };

  const getStatusClass = (status?: string) => {
    switch (status) {
      case 'healthy':
        return styles.statusHealthy;
      case 'cooling':
        return styles.statusCooling;
      case 'checking':
        return styles.statusChecking;
      default:
        return styles.statusHealthy;
    }
  };

  const getSortedLayers = useCallback((): Layer[] => {
    if (!pipeline) return [];
    return [...pipeline.layers].sort((a, b) => a.level - b.level);
  }, [pipeline]);

  // Cleanup helper
  const cleanupDrag = useCallback(() => {
    document.querySelectorAll(`.${styles.dragGhost}`).forEach(el => el.remove());
    document.body.style.userSelect = '';
  }, []);

  // Layer placeholder position
  const layerPlaceholderIdx = useMemo((): number | null => {
    if (!isDraggingLayer || layerDragSrc === null || layerDragDst === null) return null;
    if (layerDragSrc === layerDragDst) return null;
    return layerDragDst;
  }, [isDraggingLayer, layerDragSrc, layerDragDst]);

  // For target drag: compute where the placeholder should appear
  // Returns { layerIdx, targetIdx } in the ORIGINAL sorted-layer coordinate space
  // We also need to know which target ID is being dragged
  const draggedTargetId = useMemo(() => {
    if (!isDraggingTarget || !targetDragSrc) return null;
    const sorted = getSortedLayers();
    return sorted[targetDragSrc.layerIdx]?.targets[targetDragSrc.targetIdx]?.id ?? null;
  }, [isDraggingTarget, targetDragSrc, getSortedLayers]);

  // Compute placeholder position: where in the original list should the gap appear?
  // Must account for the dragged item being "removed" from source when computing visual index
  const placeholderPos = useMemo((): TargetDropPos | null => {
    if (!isDraggingTarget || !targetDragSrc || !targetDragDst || !draggedTargetId) return null;
    const src = targetDragSrc;
    const dst = targetDragDst;
    // Same position = no placeholder needed
    if (src.layerIdx === dst.layerIdx && src.targetIdx === dst.targetIdx) return null;
    return dst;
  }, [isDraggingTarget, targetDragSrc, targetDragDst, draggedTargetId]);

  // ==================== Target Pointer Drag ====================
  const handleTargetPointerDown = useCallback((layerIdx: number, targetIdx: number, e: React.PointerEvent<HTMLSpanElement>) => {
    if (!onPipelineChange || !pipeline) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const row = handle.closest(`.${styles.target}`) as HTMLElement;
    if (!row) return;

    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();

    const ghost = row.cloneNode(true) as HTMLElement;
    ghost.className = `${styles.target} ${styles.dragGhost}`;
    ghost.style.width = `${row.offsetWidth}px`;
    ghost.style.position = 'fixed';
    ghost.style.left = `${row.getBoundingClientRect().left}px`;
    ghost.style.top = `${row.getBoundingClientRect().top}px`;
    ghost.style.zIndex = '9999';
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);

    const pos = { layerIdx, targetIdx };
    targetDragRef.current = { srcLayerIdx: layerIdx, srcTargetIdx: targetIdx, ghostEl: ghost, startX: e.clientX, startY: e.clientY, pointerId: e.pointerId, rowHeight: row.offsetHeight };
    setTargetDragSrc(pos);
    setTargetDragDst(pos);
    setIsDraggingTarget(true);
  }, [onPipelineChange, pipeline]);

  const handleTargetPointerMove = useCallback((e: PointerEvent) => {
    const drag = targetDragRef.current;
    if (!drag) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    drag.ghostEl.style.transform = `translate(${dx}px, ${dy}px) scale(1.02)`;

    const sortedLayers = getSortedLayers();
    const draggedTarget = sortedLayers[drag.srcLayerIdx]?.targets[drag.srcTargetIdx];
    const draggedId = draggedTarget?.id;

    // Find closest non-dragged target by DOM position
    let closestId: string | null = null;
    let closestLayerLevel = -1;
    let closestDist = Infinity;
    let insertBefore = true;

    for (const layer of sortedLayers) {
      for (const t of layer.targets) {
        if (t.id === draggedId) continue;
        const rowEl = targetRowRefs.current.get(t.id);
        if (!rowEl) continue;
        const rect = rowEl.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const dist = Math.abs(e.clientY - midY);
        if (dist < closestDist) {
          closestDist = dist;
          closestId = t.id;
          closestLayerLevel = layer.level;
          insertBefore = e.clientY < midY;
        }
      }
    }

    // Map closest target ID back to original indices
    if (closestId) {
      for (let li = 0; li < sortedLayers.length; li++) {
        if (sortedLayers[li].level !== closestLayerLevel) continue;
        const targets = sortedLayers[li].targets;
        for (let ti = 0; ti < targets.length; ti++) {
          if (targets[ti].id === closestId) {
            setTargetDragDst({ layerIdx: li, targetIdx: insertBefore ? ti : ti + 1 });
            return;
          }
        }
      }
    }

    // Fallback: check empty layers or layers where only the dragged item exists
    for (let li = 0; li < sortedLayers.length; li++) {
      const layer = sortedLayers[li];
      const nonDraggedCount = layer.targets.filter(t => t.id !== draggedId).length;
      if (nonDraggedCount > 0) continue;
      const el = layerRefsByLevel.current.get(layer.level);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
        setTargetDragDst({ layerIdx: li, targetIdx: 0 });
        return;
      }
    }
  }, [getSortedLayers]);

  const finishTargetDrag = useCallback(() => {
    const drag = targetDragRef.current;
    if (!drag) return;

    if (targetDragSrc && targetDragDst && pipeline && onPipelineChange) {
      if (targetDragSrc.layerIdx !== targetDragDst.layerIdx || targetDragSrc.targetIdx !== targetDragDst.targetIdx) {
        const newLayers = reorderTargets(getSortedLayers(), targetDragSrc, targetDragDst);
        onPipelineChange(route.id, { ...pipeline, layers: newLayers });
      }
    }

    targetDragRef.current = null;
    setIsDraggingTarget(false);
    setTargetDragSrc(null);
    setTargetDragDst(null);
  }, [targetDragSrc, targetDragDst, pipeline, onPipelineChange, route.id, getSortedLayers]);

  // ==================== Layer Pointer Drag ====================
  const handleLayerPointerDown = useCallback((layerIdx: number, e: React.PointerEvent<HTMLSpanElement>) => {
    if (!onPipelineChange || !pipeline) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const layerEl = handle.closest(`.${styles.layer}`) as HTMLElement;
    if (!layerEl) return;

    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = 'none';
    window.getSelection()?.removeAllRanges();

    const ghost = layerEl.cloneNode(true) as HTMLElement;
    ghost.className = `${styles.layer} ${styles.dragGhost}`;
    ghost.style.width = `${layerEl.offsetWidth}px`;
    ghost.style.position = 'fixed';
    ghost.style.left = `${layerEl.getBoundingClientRect().left}px`;
    ghost.style.top = `${layerEl.getBoundingClientRect().top}px`;
    ghost.style.zIndex = '9999';
    ghost.style.pointerEvents = 'none';
    document.body.appendChild(ghost);

    layerDragRef.current = { srcLayerIdx: layerIdx, ghostEl: ghost, startY: e.clientY, pointerId: e.pointerId, layerHeight: layerEl.offsetHeight };
    setLayerDragSrc(layerIdx);
    setLayerDragDst(layerIdx);
    setIsDraggingLayer(true);
  }, [onPipelineChange, pipeline]);

  const handleLayerPointerMove = useCallback((e: PointerEvent) => {
    const drag = layerDragRef.current;
    if (!drag) return;

    const dy = e.clientY - drag.startY;
    drag.ghostEl.style.transform = `translateY(${dy}px)`;

    const sorted = getSortedLayers();
    let bestIdx = drag.srcLayerIdx;
    let bestDist = Infinity;
    for (let i = 0; i < sorted.length; i++) {
      if (i === drag.srcLayerIdx) continue;
      const el = layerRefsByLevel.current.get(sorted[i].level);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(e.clientY - midY);
      if (dist < bestDist) { bestDist = dist; bestIdx = i; }
    }
    setLayerDragDst(bestIdx);
  }, [getSortedLayers]);

  const finishLayerDrag = useCallback(() => {
    const drag = layerDragRef.current;
    if (!drag) return;

    if (layerDragSrc !== null && layerDragDst !== null && layerDragSrc !== layerDragDst && pipeline && onPipelineChange) {
      const sortedLayers = getSortedLayers();
      const newLayers = [...sortedLayers];
      const [moved] = newLayers.splice(layerDragSrc, 1);
      newLayers.splice(layerDragDst, 0, moved);
      const reindexed = newLayers.map((layer, i) => ({ ...layer, level: i + 1 }));
      onPipelineChange(route.id, { ...pipeline, layers: reindexed });
    }

    layerDragRef.current = null;
    setIsDraggingLayer(false);
    setLayerDragSrc(null);
    setLayerDragDst(null);
  }, [layerDragSrc, layerDragDst, pipeline, onPipelineChange, route.id, getSortedLayers]);

  // Prevent text selection during drags
  const preventSelect = useCallback((e: Event) => e.preventDefault(), []);

  // Global pointer event listeners
  useEffect(() => {
    if (isDraggingTarget) {
      window.addEventListener('pointermove', handleTargetPointerMove);
      window.addEventListener('pointerup', finishTargetDrag);
      window.addEventListener('pointercancel', finishTargetDrag);
      document.addEventListener('selectstart', preventSelect);
      return () => {
        window.removeEventListener('pointermove', handleTargetPointerMove);
        window.removeEventListener('pointerup', finishTargetDrag);
        window.removeEventListener('pointercancel', finishTargetDrag);
        document.removeEventListener('selectstart', preventSelect);
      };
    }
  }, [isDraggingTarget, handleTargetPointerMove, finishTargetDrag, preventSelect]);

  useEffect(() => {
    if (isDraggingLayer) {
      window.addEventListener('pointermove', handleLayerPointerMove);
      window.addEventListener('pointerup', finishLayerDrag);
      window.addEventListener('pointercancel', finishLayerDrag);
      document.addEventListener('selectstart', preventSelect);
      return () => {
        window.removeEventListener('pointermove', handleLayerPointerMove);
        window.removeEventListener('pointerup', finishLayerDrag);
        window.removeEventListener('pointercancel', finishLayerDrag);
        document.removeEventListener('selectstart', preventSelect);
      };
    }
  }, [isDraggingLayer, handleLayerPointerMove, finishLayerDrag, preventSelect]);

  // Cleanup ghosts after drag ends — delayed to let React re-render first
  useEffect(() => {
    if (!isDraggingTarget && !isDraggingLayer) {
      const id = requestAnimationFrame(() => {
        cleanupDrag();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [isDraggingTarget, isDraggingLayer, cleanupDrag]);

  // Clean up not-found targets from a layer
  const handleCleanupLayer = useCallback((layerLevel: number) => {
    if (!pipeline || !onPipelineChange) return;
    const newLayers = pipeline.layers.map(layer => {
      if (layer.level !== layerLevel) return layer;
      return {
        ...layer,
        targets: layer.targets.filter(t => getCredentialStatus(t.credential_id) !== 'not_found'),
      };
    });
    onPipelineChange(route.id, { ...pipeline, layers: newLayers });
  }, [pipeline, onPipelineChange, route.id, credentials]);

  const hasNotFoundTargets = useCallback((layer: Layer) => {
    return layer.targets.some(t => getCredentialStatus(t.credential_id) === 'not_found');
  }, [credentials]);

  // Which layer level is being dragged?
  const draggedLayerLevel = useMemo(() => {
    if (!isDraggingLayer || layerDragSrc === null) return null;
    const sorted = getSortedLayers();
    return sorted[layerDragSrc]?.level ?? null;
  }, [isDraggingLayer, layerDragSrc, getSortedLayers]);

  const targetHasMoved = useMemo(() => {
    if (!targetDragSrc || !targetDragDst) return false;
    return targetDragSrc.layerIdx !== targetDragDst.layerIdx
        || targetDragSrc.targetIdx !== targetDragDst.targetIdx;
  }, [targetDragSrc, targetDragDst]);

  const layerHasMoved = useMemo(() => {
    return layerDragSrc !== null && layerDragDst !== null && layerDragSrc !== layerDragDst;
  }, [layerDragSrc, layerDragDst]);

  // Should a target placeholder appear before targetIdx in layerIdx? (original coords)
  const showTargetPlaceholder = useCallback((layerIdx: number, targetIdx: number): boolean => {
    if (!placeholderPos) return false;
    return placeholderPos.layerIdx === layerIdx && placeholderPos.targetIdx === targetIdx;
  }, [placeholderPos]);

  // Should a target placeholder appear at end of layer? (original coords)
  const showTargetPlaceholderEnd = useCallback((layerIdx: number, targetCount: number): boolean => {
    if (!placeholderPos) return false;
    return placeholderPos.layerIdx === layerIdx && placeholderPos.targetIdx >= targetCount;
  }, [placeholderPos]);

  return (
    <div className={`${styles.card} ${!route.enabled ? styles.disabled : ''}`}>
      {/* Header */}
      <div className={styles.header} onClick={handleToggleExpand}>
        <div className={styles.headerLeft}>
          <span className={styles.expandIcon}>{expanded ? '▼' : '▶'}</span>
          <span className={styles.routeName}>{route.name}</span>
          {route.aliases && route.aliases.length > 0 && (
            <span className={styles.aliasBadges}>
              {route.aliases.map((alias) => (
                <span key={alias} className={styles.aliasBadge}>{alias}</span>
              ))}
            </span>
          )}
          {!route.enabled && (
            <span className={styles.disabledBadge}>{t('common.disabled')}</span>
          )}
        </div>
        <div className={styles.headerActions} onClick={(e) => e.stopPropagation()}>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleSimulateRoute}
            disabled={disabled || simulating || checkingAll || !pipeline?.layers?.length}
            loading={simulating}
          >
            {t('unified_routing.simulate_route')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCheckAll}
            disabled={disabled || checkingAll || simulating || !pipeline?.layers?.length}
            loading={checkingAll}
          >
            {t('unified_routing.check_all')}
          </Button>
          {hasAnyResults && (
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAllResults}
              disabled={disabled || checkingAll || simulating}
            >
              ✕
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEdit(route.id)}
            disabled={disabled}
          >
            {t('common.edit')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDelete(route.id)}
            disabled={disabled}
          >
            {t('common.delete')}
          </Button>
        </div>
      </div>

      {/* Description */}
      {route.description && (
        <div className={styles.description}>"{route.description}"</div>
      )}

      {/* Expanded Content - Layers */}
      {expanded && (
        <div className={styles.layersContainer} ref={layersContainerRef}>
          {loading ? (
            <div className={styles.loadingLayers}>{t('common.loading')}</div>
          ) : pipeline && pipeline.layers.length > 0 ? (
            <>
              {getSortedLayers().map((layer, layerIdx) => {
                const layerBeingDragged = draggedLayerLevel === layer.level;
                const showLayerPlaceholderBefore = layerPlaceholderIdx === layerIdx;

                return (
                  <React.Fragment key={layer.level}>
                    <div
                      className={styles.layerGap}
                      style={{ height: showLayerPlaceholderBefore ? (layerDragRef.current?.layerHeight ?? 80) : 0 }}
                    />
                    <div
                      className={styles.layerWrap}
                      style={
                        layerBeingDragged
                          ? { height: layerHasMoved ? 0 : (layerDragRef.current?.layerHeight ?? 'auto'), transition: 'none' }
                          : undefined
                      }
                    >
                    <div
                      ref={el => {
                        layerRefs.current[layerIdx] = el;
                        if (el) layerRefsByLevel.current.set(layer.level, el);
                      }}
                      className={styles.layer}
                      style={layerBeingDragged ? { opacity: 0 } : undefined}
                    >
                    <div className={styles.layerHeader}>
                      <span
                        className={styles.layerDragHandle}
                        onPointerDown={(e) => handleLayerPointerDown(layerIdx, e)}
                        title={t('unified_routing.drag_layer', { defaultValue: '拖动交换层' })}
                      >
                        ⠿
                      </span>
                      <span className={styles.layerTitle}>
                        Layer {layerIdx + 1}
                      </span>
                      <span className={styles.layerStrategy}>
                        {layer.strategy}
                      </span>
                      <div className={styles.layerActions}>
                        {hasNotFoundTargets(layer) && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleCleanupLayer(layer.level)}
                            disabled={disabled}
                          >
                            {t('unified_routing.cleanup_deleted', { defaultValue: '清除已删除' })}
                          </Button>
                        )}
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => onAddTarget(route.id, layer.level)}
                          disabled={disabled}
                        >
                          + {t('unified_routing.add_target')}
                        </Button>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => onDeleteLayer(route.id, layer.level)}
                          disabled={disabled}
                        >
                          {t('common.delete')}
                        </Button>
                      </div>
                    </div>
                    <div className={styles.targets}>
                      {layer.targets.map((target, targetIdx) => {
                        const cred = getCredentialInfo(target.credential_id);
                        const credStatus = getCredentialStatus(target.credential_id);
                        const state = getTargetState(target.id);
                        const sim = simulateStatus[target.id];
                        const hc = healthCheckStatus[target.id];
                        const isLast = targetIdx === layer.targets.length - 1;
                        const isBeingDragged = draggedTargetId === target.id;
                        const placeholderBefore = showTargetPlaceholder(layerIdx, targetIdx);

                        const targetLabel = `${cred?.provider || 'unknown'}/${cred?.label || target.credential_id}/${target.model}`;

                        const renderResultBadge = (result: TargetHealthStatus) => {
                          const isFailed = result.status === 'failed' && result.message;
                          return (
                            <span
                              className={`${styles.healthStatus} ${
                                result.status === 'checking' ? styles.healthChecking :
                                result.status === 'success' ? styles.healthSuccess :
                                result.status === 'skipped' ? styles.healthSkipped :
                                styles.healthFailed
                              } ${isFailed ? styles.clickable : ''}`}
                              title={result.message}
                              onClick={isFailed ? (e) => {
                                e.stopPropagation();
                                setErrorModal({ targetName: targetLabel, errorMessage: result.message! });
                              } : undefined}
                            >
                              {result.status === 'checking' ? (
                                <>⟳ {t('unified_routing.checking')}</>
                              ) : result.status === 'success' ? (
                                <>✓ {result.latency_ms ? `${result.latency_ms}ms` : t('unified_routing.success')}</>
                              ) : result.status === 'skipped' ? (
                                <>- {t('unified_routing.skipped')}</>
                              ) : (
                                <>✕ {t('unified_routing.failed')}</>
                              )}
                            </span>
                          );
                        };

                        const dragHeight = targetDragRef.current?.rowHeight ?? 36;

                        return (
                          <div key={target.id}>
                            <div
                              className={styles.targetGap}
                              style={{ height: placeholderBefore ? dragHeight : 0 }}
                            />
                            <div
                              className={styles.targetWrap}
                              style={
                                isBeingDragged
                                  ? { height: targetHasMoved ? 0 : (targetDragRef.current?.rowHeight ?? 'auto'), transition: 'none' }
                                  : undefined
                              }
                            >
                              <div
                                ref={el => {
                                  if (el) targetRowRefs.current.set(target.id, el);
                                }}
                                className={`${styles.target} ${!target.enabled ? styles.targetDisabled : ''}`}
                                style={isBeingDragged ? { opacity: 0 } : undefined}
                              >
                              <span
                                className={styles.dragHandle}
                                onPointerDown={(e) => handleTargetPointerDown(layerIdx, targetIdx, e)}
                                title={t('unified_routing.drag_target', { defaultValue: '拖动排序' })}
                              >
                                ⠿
                              </span>
                              <span className={styles.targetBranch}>
                                {isLast ? '└─' : '├─'}
                              </span>
                              <span
                                className={`${styles.targetPath} ${
                                  credStatus === 'not_found'
                                    ? (target.enabled ? styles.credNotFound : styles.credNotFoundFaded)
                                    : credStatus === 'disabled'
                                      ? (target.enabled ? styles.credDisabled : styles.credDisabledFaded)
                                      : ''
                                }`}
                                title={
                                  credStatus === 'not_found' ? 'credential not found'
                                  : credStatus === 'disabled' ? 'credential disabled'
                                  : undefined
                                }
                              >
                                <span className={styles.provider}>
                                  {cred?.provider || 'unknown'}
                                </span>
                                /
                                <span className={styles.credential}>
                                  {cred?.label || target.credential_id}
                                </span>
                                /
                                <span className={styles.model}>{target.model}</span>
                              </span>

                              <span className={styles.col1}>
                                <span
                                  className={`${styles.targetStatus} ${getStatusClass(state?.status)}`}
                                >
                                  {state?.status === 'checking' ? (
                                    <>●</>
                                  ) : state?.status === 'cooling' ? (
                                    (() => {
                                      const text = formatCooldown(state);
                                      if (text != null) return <>○ {text}</>;
                                      return <>●</>;
                                    })()
                                  ) : (
                                    <>●</>
                                  )}
                                </span>
                                {sim?.status === 'success' && sim.latency_ms != null && (
                                  <span className={styles.simLatency}>
                                    {sim.latency_ms}ms
                                  </span>
                                )}
                                {(state?.status === 'cooling' || state?.status === 'checking') && state?.last_failure_reason && (
                                  <span
                                    className={`${styles.failureLabel} ${styles.clickable}`}
                                    title={state.last_failure_reason}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setErrorModal({ targetName: targetLabel, errorMessage: state.last_failure_reason! });
                                    }}
                                  >
                                    {t('unified_routing.failed')}
                                  </span>
                                )}
                                {state && state.total_requests > 0 && (
                                  <span className={styles.targetStats}>
                                    [{state.successful_requests}/{state.total_requests}]
                                  </span>
                                )}
                              </span>

                              <span className={styles.rightSection}>
                                <span className={styles.col2}>
                                  {hc ? renderResultBadge(hc) : null}
                                </span>
                                <span
                                  className={styles.targetActions}
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <button
                                    className={styles.iconButton}
                                    onClick={() => onEditTarget(route.id, layer.level, target)}
                                    disabled={disabled}
                                    title={t('common.edit')}
                                  >
                                    ✎
                                  </button>
                                  <button
                                    className={styles.iconButton}
                                    onClick={() =>
                                      onDeleteTarget(route.id, layer.level, target.id)
                                    }
                                    disabled={disabled}
                                    title={t('common.delete')}
                                  >
                                    ✕
                                  </button>
                                </span>
                              </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      <div
                        className={styles.targetGap}
                        style={{ height: showTargetPlaceholderEnd(layerIdx, layer.targets.length) ? (targetDragRef.current?.rowHeight ?? 36) : 0 }}
                      />
                      {layer.targets.length === 0 && !showTargetPlaceholder(layerIdx, 0) && !showTargetPlaceholderEnd(layerIdx, 0) && (
                        <div className={`${styles.emptyLayer} ${isDraggingTarget ? styles.emptyLayerHighlight : ''}`}>
                          {isDraggingTarget
                            ? t('unified_routing.drop_here', { defaultValue: '放置到此层' })
                            : t('unified_routing.no_targets_in_layer')}
                        </div>
                      )}
                    </div>
                  </div>
                  </div>
                  </React.Fragment>
                );
              })}
              <div
                className={styles.layerGap}
                style={{ height: layerPlaceholderIdx !== null && layerPlaceholderIdx >= getSortedLayers().length ? (layerDragRef.current?.layerHeight ?? 80) : 0 }}
              />
              <div className={styles.addLayerSection}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAddLayer(route.id)}
                  disabled={disabled}
                >
                  + {t('unified_routing.add_layer')}
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.emptyPipeline}>
              <p>{t('unified_routing.no_pipeline')}</p>
              <Button
                variant="primary"
                size="sm"
                onClick={() => onSelect(route.id)}
                disabled={disabled}
              >
                {t('unified_routing.configure_pipeline')}
              </Button>
            </div>
          )}
        </div>
      )}
      
      {/* Error Detail Modal */}
      <Modal
        open={!!errorModal}
        onClose={() => setErrorModal(null)}
        title={t('unified_routing.error_details')}
        width={500}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                if (errorModal) {
                  navigator.clipboard.writeText(errorModal.errorMessage);
                }
              }}
            >
              {t('common.copy')}
            </Button>
            <Button onClick={() => setErrorModal(null)}>
              {t('common.close')}
            </Button>
          </>
        }
      >
        {errorModal && (
          <>
            <div className={styles.modalTarget}>
              <strong>{t('unified_routing.target')}:</strong> {errorModal.targetName}
            </div>
            <div className={styles.modalError}>
              <strong>{t('unified_routing.error_message')}:</strong>
              <pre className={styles.errorContent}>{errorModal.errorMessage}</pre>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
